import Foundation

/// A calendar store read from a JSON fixture and kept in memory. Writes change memory only; the
/// file is never written. Used by tests and by `boundary-calendar-helper --fixture <path>`.
///
/// Fixture format: {"access"?, "calendars": [CalendarInfo], "events": [...]}, where an event has
/// the wire fields (start and end as protocol strings; all-day ends exclusive) plus an optional
/// "rrule". A recurring event expands into occurrences with ids "<event id>@<unix seconds of the
/// occurrence's original start>".
public final class FixtureStore: CalendarStore {
  private struct FixtureFile: Decodable {
    let access: AccessStatus?
    let calendars: [CalendarInfo]
    let events: [FixtureEvent]
  }

  private struct FixtureEvent: Decodable {
    let id: String
    let calendarId: String
    let title: String
    let start: String
    let end: String
    let allDay: Bool?
    let location: String?
    let notes: String?
    let url: String?
    let rrule: String?
    let attendees: [Attendee]?
  }

  /// A single event, a recurring series, or one detached occurrence of a series.
  private struct Stored {
    /// For a series, the first occurrence with the series id.
    var record: EventRecord
    var rule: RecurrenceRule?
    /// Original starts of occurrences that were deleted or detached.
    var excluded: Set<Int> = []
    /// Occurrences whose original start is at or after this are gone.
    var cutoff: Date?
    /// Set on a detached occurrence: its series and the start it had before it was changed.
    var seriesId: String?
    var originalStart: Date?
  }

  private enum Target {
    case single(Int)
    case detached(Int)
    case occurrence(series: Int, originalStart: Date, index: Int)
  }

  private let dates: WireDates
  private var access: AccessStatus
  private let calendars: [CalendarInfo]
  private var events: [Stored]
  private var createdCount = 0
  private var pendingAccessRequests: [@Sendable (AccessStatus) -> Void] = []

  /// When true, `requestAccess` on an undetermined status waits until `answerAccessRequests` is
  /// called, standing in for a system prompt the person hasn't answered yet.
  public var holdsAccessRequests = false

  /// `access` overrides the fixture file's access status.
  public init(path: String, timeZone: TimeZone = .current, access: AccessStatus? = nil) throws {
    dates = WireDates(timeZone: timeZone)
    let data: Data
    do {
      data = try Data(contentsOf: URL(fileURLWithPath: path))
    } catch {
      throw HelperError(.internal, "The fixture file couldn't be read")
    }
    let file: FixtureFile
    do {
      file = try JSONDecoder().decode(FixtureFile.self, from: data)
    } catch {
      throw HelperError(.internal, "The fixture file isn't valid")
    }
    self.access = access ?? file.access ?? .granted
    calendars = file.calendars
    events = []
    for event in file.events {
      events.append(try load(event))
    }
  }

  private func load(_ event: FixtureEvent) throws -> Stored {
    guard var start = dates.parse(event.start), var end = dates.parse(event.end) else {
      throw HelperError(.internal, "Fixture event \(event.id) has an unreadable time")
    }
    let allDay = event.allDay ?? false
    if allDay {
      end = dates.allDayEnd(start: start, end: end)
      start = dates.startOfDay(start)
    }
    let rule = try event.rrule.map { try RecurrenceRule.parse($0, timeZone: dates.timeZone) }
    let record = EventRecord(
      id: event.id, calendarId: event.calendarId, title: event.title, start: start, end: end,
      allDay: allDay, location: event.location, notes: event.notes, url: event.url,
      recurring: rule != nil, attendees: event.attendees ?? [])
    return Stored(record: record, rule: rule)
  }

  // MARK: - CalendarStore

  public func status() -> AccessStatus {
    access
  }

  public func requestAccess(completion: @escaping @Sendable (AccessStatus) -> Void) {
    guard access == .notDetermined else { return completion(access) }
    if holdsAccessRequests {
      pendingAccessRequests.append(completion)
      return
    }
    access = .granted
    completion(access)
  }

  /// Answers every held `requestAccess` with `status`, which becomes the store's status.
  public func answerAccessRequests(with status: AccessStatus) {
    access = status
    let waiting = pendingAccessRequests
    pendingAccessRequests = []
    for completion in waiting { completion(status) }
  }

  public func listCalendars() throws -> [CalendarInfo] {
    calendars
  }

  public func listEvents(calendarIds: [String], start: Date, end: Date) throws -> [EventRecord] {
    for id in calendarIds { _ = try calendar(id) }
    let wanted = Set(calendarIds)
    var found: [EventRecord] = []
    for stored in events where wanted.contains(stored.record.calendarId) {
      let candidates = stored.rule == nil ? [stored.record] : occurrences(of: stored, before: end)
      found += candidates.filter { $0.overlaps(start: start, end: end) }
    }
    return found.sorted { ($0.start, $0.id) < ($1.start, $1.id) }
  }

  public func search(calendarIds: [String], query: String, start: Date, end: Date) throws
    -> [EventRecord]
  {
    try listEvents(calendarIds: calendarIds, start: start, end: end)
      .filter { $0.matches(query: query) }
  }

  public func getEvent(id: String) throws -> EventRecord {
    record(for: try resolve(id))
  }

  public func createEvent(_ draft: EventDraft) throws -> EventRecord {
    try requireWritable(draft.calendarId)
    createdCount += 1
    let record = EventRecord(
      id: "fixture-created-\(createdCount)", calendarId: draft.calendarId, title: draft.title,
      start: draft.start, end: draft.end, allDay: draft.allDay, location: draft.location,
      notes: draft.notes, recurring: draft.recurrence != nil)
    let stored = Stored(record: record, rule: draft.recurrence)
    events.append(stored)
    return firstRecord(of: stored)
  }

  public func updateEvent(id: String, span: Span, changes: EventChanges) throws -> EventRecord {
    let target = try resolve(id)
    let current = record(for: target)
    try requireWritable(current.calendarId)
    if let destination = changes.calendarId { try requireWritable(destination) }
    let next = try current.applying(changes, dates: dates)

    switch (target, span) {
    case (.single(let index), _), (.detached(let index), .this):
      events[index].record = next
      return next
    case (.occurrence(let series, let originalStart, _), .this):
      events[series].excluded.insert(seconds(originalStart))
      events.append(
        Stored(
          record: next, seriesId: events[series].record.id, originalStart: originalStart))
      return next
    case (.occurrence, .future), (.detached, .future):
      let (series, originalStart, index) = try seriesPosition(of: target)
      return try split(series: series, at: originalStart, index: index, first: next)
    }
  }

  public func deleteEvent(id: String, span: Span) throws {
    let target = try resolve(id)
    try requireWritable(record(for: target).calendarId)
    switch (target, span) {
    case (.single(let index), _), (.detached(let index), .this):
      events.remove(at: index)
    case (.occurrence(let series, let originalStart, _), .this):
      events[series].excluded.insert(seconds(originalStart))
    case (.occurrence, .future), (.detached, .future):
      let (series, originalStart, _) = try seriesPosition(of: target)
      truncate(series: series, at: originalStart)
    }
  }

  public func observeChanges(_ onChange: @escaping @Sendable () -> Void) {
    // The fixture only changes through this store's own writes.
  }

  // MARK: - Calendars

  private func calendar(_ id: String) throws -> CalendarInfo {
    guard let calendar = calendars.first(where: { $0.id == id }) else {
      throw HelperError.calendarNotFound(id)
    }
    return calendar
  }

  private func requireWritable(_ calendarId: String) throws {
    guard try calendar(calendarId).writable else {
      throw HelperError.readOnlyCalendar(calendarId)
    }
  }

  // MARK: - Recurrence

  private func seconds(_ date: Date) -> Int {
    Int(date.timeIntervalSince1970.rounded())
  }

  private func occurrenceId(_ seriesId: String, _ originalStart: Date) -> String {
    "\(seriesId)@\(seconds(originalStart))"
  }

  /// Original starts of a series before `limit`, skipping none: excluded ones are filtered later.
  private func starts(of stored: Stored, before limit: Date) -> [Date] {
    guard let rule = stored.rule else { return [stored.record.start] }
    let calendar = dates.calendar
    var found: [Date] = []
    var step = 0
    while step < 10_000 {
      if let count = rule.count, step >= count { break }
      guard
        let start = calendar.date(
          byAdding: rule.frequency.component, value: step * rule.interval,
          to: stored.record.start)
      else { break }
      if let until = rule.until, start > until { break }
      if let cutoff = stored.cutoff, start >= cutoff { break }
      if start >= limit { break }
      found.append(start)
      step += 1
    }
    return found
  }

  private func occurrence(of stored: Stored, at start: Date) -> EventRecord {
    var record = stored.record
    record.id = occurrenceId(stored.record.id, start)
    record.start = start
    if record.allDay {
      let days =
        dates.calendar.dateComponents(
          [.day], from: stored.record.start, to: stored.record.end
        ).day ?? 1
      record.end = dates.calendar.date(byAdding: .day, value: days, to: start) ?? start
    } else {
      record.end = start.addingTimeInterval(stored.record.end.timeIntervalSince(stored.record.start))
    }
    return record
  }

  /// A series' generated occurrences that start before `limit`. Detached occurrences are
  /// stored on their own and listed like single events.
  private func occurrences(of stored: Stored, before limit: Date) -> [EventRecord] {
    starts(of: stored, before: limit)
      .filter { !stored.excluded.contains(seconds($0)) }
      .map { occurrence(of: stored, at: $0) }
  }

  /// A new event as the caller sees it: a series reads as its first occurrence.
  private func firstRecord(of stored: Stored) -> EventRecord {
    stored.rule == nil ? stored.record : occurrence(of: stored, at: stored.record.start)
  }

  private func resolve(_ id: String) throws -> Target {
    if let index = events.firstIndex(where: { $0.record.id == id }) {
      let stored = events[index]
      if stored.seriesId != nil { return .detached(index) }
      if stored.rule == nil { return .single(index) }
      // A bare series id stands for its first occurrence.
      return try resolve(occurrenceId(id, stored.record.start))
    }
    guard let at = id.lastIndex(of: "@"), let epoch = Int(id[id.index(after: at)...]) else {
      throw HelperError.eventNotFound(id)
    }
    let seriesId = String(id[..<at])
    guard let series = events.firstIndex(where: { $0.record.id == seriesId && $0.rule != nil })
    else { throw HelperError.eventNotFound(id) }
    let stored = events[series]
    let originalStart = Date(timeIntervalSince1970: TimeInterval(epoch))
    let all = starts(of: stored, before: originalStart.addingTimeInterval(1))
    guard let index = all.firstIndex(where: { seconds($0) == epoch }),
      !stored.excluded.contains(epoch)
    else { throw HelperError.eventNotFound(id) }
    return .occurrence(series: series, originalStart: all[index], index: index)
  }

  private func record(for target: Target) -> EventRecord {
    switch target {
    case .single(let index), .detached(let index):
      return events[index].record
    case .occurrence(let series, let originalStart, _):
      return occurrence(of: events[series], at: originalStart)
    }
  }

  /// The series, original start and step number of an occurrence or detached occurrence.
  private func seriesPosition(of target: Target) throws -> (Int, Date, Int) {
    switch target {
    case .occurrence(let series, let originalStart, let index):
      return (series, originalStart, index)
    case .detached(let index):
      let detached = events[index]
      guard let seriesId = detached.seriesId, let originalStart = detached.originalStart,
        let series = events.firstIndex(where: { $0.record.id == seriesId })
      else { throw HelperError.eventNotFound(detached.record.id) }
      let all = starts(of: events[series], before: originalStart.addingTimeInterval(1))
      return (series, originalStart, max(all.count - 1, 0))
    case .single(let index):
      return (index, events[index].record.start, 0)
    }
  }

  /// Ends a series before `originalStart` and drops its detached occurrences from there on.
  private func truncate(series: Int, at originalStart: Date) {
    let seriesId = events[series].record.id
    if seconds(originalStart) == seconds(events[series].record.start) {
      events.removeAll { $0.record.id == seriesId || $0.seriesId == seriesId }
      return
    }
    events[series].cutoff = originalStart
    events.removeAll { stored in
      guard stored.seriesId == seriesId, let start = stored.originalStart else { return false }
      return start >= originalStart
    }
  }

  /// Applies a "future" change: the old series stops before `originalStart`, and a new series
  /// starts from the changed occurrence `first`.
  private func split(series: Int, at originalStart: Date, index: Int, first: EventRecord) throws
    -> EventRecord
  {
    let old = events[series]
    guard var rule = old.rule else { throw HelperError.eventNotFound(first.id) }
    if let count = rule.count { rule.count = max(count - index, 1) }
    createdCount += 1
    var record = first
    record.id = "\(old.record.id)-\(createdCount)"
    record.recurring = true
    let shift = first.start.timeIntervalSince(originalStart)
    var next = Stored(record: record, rule: rule)
    next.excluded = Set(
      old.excluded.filter { $0 > seconds(originalStart) }.map { $0 + Int(shift.rounded()) })
    truncate(series: series, at: originalStart)
    events.append(next)
    return firstRecord(of: next)
  }
}
