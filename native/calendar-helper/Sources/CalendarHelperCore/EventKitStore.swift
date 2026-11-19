import CoreGraphics
import EventKit
import Foundation

/// The Mac's calendars through EventKit.
///
/// Event ids: a single event's id is its `eventIdentifier`. EventKit gives every occurrence of a
/// recurring event the same `eventIdentifier`, so an occurrence's id adds the unix seconds of
/// its `occurrenceDate`: "<eventIdentifier>@<seconds>". All id handling lives in this file.
///
/// No test runs this store: tests use FixtureStore, and nothing in the test suite may ask for
/// calendar access.
public final class EventKitStore: CalendarStore, @unchecked Sendable {
  private let store = EKEventStore()
  private let dates: WireDates
  private var observer: NSObjectProtocol?

  /// How far from an occurrence's original date to look for it when resolving its id. An
  /// occurrence moved further than this can't be found by id.
  private let occurrenceWindow: TimeInterval = 31 * 24 * 3600

  public init(timeZone: TimeZone = .current) {
    dates = WireDates(timeZone: timeZone)
  }

  deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
  }

  // MARK: - Access

  public func status() -> AccessStatus {
    Self.currentStatus()
  }

  private static func currentStatus() -> AccessStatus {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .notDetermined: return .notDetermined
    case .restricted: return .restricted
    case .denied: return .denied
    case .fullAccess: return .granted
    case .writeOnly: return .writeOnly
    @unknown default: return .denied
    }
  }

  /// Returns at once; `completion` runs when the person has answered the system prompt. Only
  /// the first request can prompt.
  public func requestAccess(completion: @escaping @Sendable (AccessStatus) -> Void) {
    guard Self.currentStatus() == .notDetermined else { return completion(Self.currentStatus()) }
    if #available(macOS 14, *) {
      store.requestFullAccessToEvents { _, _ in completion(Self.currentStatus()) }
    } else {
      store.requestAccess(to: .event) { _, _ in completion(Self.currentStatus()) }
    }
  }

  // MARK: - Calendars

  public func listCalendars() throws -> [CalendarInfo] {
    store.calendars(for: .event).map(info)
  }

  private func info(_ calendar: EKCalendar) -> CalendarInfo {
    CalendarInfo(
      id: calendar.calendarIdentifier,
      title: calendar.title,
      color: hex(calendar.cgColor),
      source: calendar.source?.title ?? "",
      kind: kind(calendar),
      writable: isWritable(calendar)
    )
  }

  private func kind(_ calendar: EKCalendar) -> CalendarKind {
    switch calendar.type {
    case .birthday: return .birthdays
    case .subscription: return .subscribed
    case .exchange: return .exchange
    case .local: return .local
    case .calDAV:
      guard let source = calendar.source else { return .caldav }
      if source.sourceType == .mobileMe { return .icloud }
      // EventKit doesn't name the provider of a CalDAV account; macOS titles them by service.
      let title = source.title.lowercased()
      if title.contains("icloud") { return .icloud }
      if title.contains("google") || title.contains("gmail") { return .google }
      return .caldav
    @unknown default:
      return .other
    }
  }

  private func isWritable(_ calendar: EKCalendar) -> Bool {
    calendar.allowsContentModifications && calendar.type != .subscription
      && calendar.type != .birthday
  }

  private func hex(_ color: CGColor?) -> String {
    guard let color,
      let sRGB = CGColorSpace(name: CGColorSpace.sRGB),
      let converted = color.converted(to: sRGB, intent: .defaultIntent, options: nil),
      let parts = converted.components, parts.count >= 3
    else { return "#808080" }
    let bytes = parts.prefix(3).map { Int((min(max($0, 0), 1) * 255).rounded()) }
    return "#" + bytes.map { String(format: "%02x", $0) }.joined()
  }

  private func calendars(_ ids: [String]) throws -> [EKCalendar] {
    try ids.map(calendar)
  }

  private func calendar(_ id: String) throws -> EKCalendar {
    guard let calendar = store.calendar(withIdentifier: id),
      calendar.allowedEntityTypes.contains(.event)
    else { throw HelperError.calendarNotFound(id) }
    return calendar
  }

  private func writableCalendar(_ id: String) throws -> EKCalendar {
    let calendar = try calendar(id)
    guard isWritable(calendar) else { throw HelperError.readOnlyCalendar(id) }
    return calendar
  }

  // MARK: - Reading events

  public func listEvents(calendarIds: [String], start: Date, end: Date) throws -> [EventRecord] {
    let wanted = try calendars(calendarIds)
    if wanted.isEmpty { return [] }
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: wanted)
    return store.events(matching: predicate)
      .map(record)
      .filter { $0.overlaps(start: start, end: end) }
      .sorted { ($0.start, $0.id) < ($1.start, $1.id) }
  }

  public func search(calendarIds: [String], query: String, start: Date, end: Date) throws
    -> [EventRecord]
  {
    try listEvents(calendarIds: calendarIds, start: start, end: end)
      .filter { $0.matches(query: query) }
  }

  public func getEvent(id: String) throws -> EventRecord {
    record(try event(id))
  }

  private func isRecurring(_ event: EKEvent) -> Bool {
    event.hasRecurrenceRules || event.isDetached
  }

  private func seconds(_ date: Date) -> Int {
    Int(date.timeIntervalSince1970.rounded())
  }

  private func id(of event: EKEvent) -> String {
    let base = event.eventIdentifier ?? ""
    guard isRecurring(event) else { return base }
    return "\(base)@\(seconds(event.occurrenceDate ?? event.startDate))"
  }

  private func event(_ id: String) throws -> EKEvent {
    if let event = store.event(withIdentifier: id), !isRecurring(event) { return event }
    guard let at = id.lastIndex(of: "@"), let epoch = Int(id[id.index(after: at)...]) else {
      // A bare identifier of a recurring event: EventKit returns its first occurrence.
      if let event = store.event(withIdentifier: id) { return event }
      throw HelperError.eventNotFound(id)
    }
    let base = String(id[..<at])
    guard let any = store.event(withIdentifier: base), let calendar = any.calendar else {
      throw HelperError.eventNotFound(id)
    }
    let original = Date(timeIntervalSince1970: TimeInterval(epoch))
    let predicate = store.predicateForEvents(
      withStart: original.addingTimeInterval(-occurrenceWindow),
      end: original.addingTimeInterval(occurrenceWindow),
      calendars: [calendar])
    let match = store.events(matching: predicate).first { candidate in
      candidate.eventIdentifier == base
        && seconds(candidate.occurrenceDate ?? candidate.startDate) == epoch
    }
    guard let match else { throw HelperError.eventNotFound(id) }
    return match
  }

  private func record(_ event: EKEvent) -> EventRecord {
    let allDay = event.isAllDay
    let start: Date = allDay ? dates.startOfDay(event.startDate) : event.startDate
    let end: Date =
      allDay ? dates.allDayEnd(start: event.startDate, end: event.endDate) : event.endDate
    return EventRecord(
      id: id(of: event),
      calendarId: event.calendar?.calendarIdentifier ?? "",
      title: event.title ?? "",
      start: start,
      end: end,
      allDay: allDay,
      location: nonEmpty(event.location),
      notes: nonEmpty(event.notes),
      url: event.url?.absoluteString,
      recurring: isRecurring(event),
      attendees: (event.attendees ?? []).map(attendee)
    )
  }

  private func nonEmpty(_ text: String?) -> String? {
    guard let text, !text.isEmpty else { return nil }
    return text
  }

  private func attendee(_ participant: EKParticipant) -> Attendee {
    let url = participant.url
    let email = url.scheme?.lowercased() == "mailto"
      ? url.absoluteString.dropFirst("mailto:".count).removingPercentEncoding
      : nil
    return Attendee(
      name: nonEmpty(participant.name), email: nonEmpty(email),
      status: statusName(participant.participantStatus))
  }

  private func statusName(_ status: EKParticipantStatus) -> String {
    switch status {
    case .unknown: return "unknown"
    case .pending: return "pending"
    case .accepted: return "accepted"
    case .declined: return "declined"
    case .tentative: return "tentative"
    case .delegated: return "delegated"
    case .completed: return "completed"
    case .inProcess: return "inProcess"
    @unknown default: return "unknown"
    }
  }

  // MARK: - Writing events

  public func createEvent(_ draft: EventDraft) throws -> EventRecord {
    let event = EKEvent(eventStore: store)
    event.calendar = try writableCalendar(draft.calendarId)
    event.title = draft.title
    event.location = draft.location
    event.notes = draft.notes
    setTimes(event, start: draft.start, end: draft.end, allDay: draft.allDay)
    if let rule = draft.recurrence { event.recurrenceRules = [recurrenceRule(rule)] }
    try commit { try store.save(event, span: .thisEvent, commit: true) }
    return record(event)
  }

  public func updateEvent(id: String, span: Span, changes: EventChanges) throws -> EventRecord {
    let event = try event(id)
    let current = record(event)
    _ = try writableCalendar(current.calendarId)
    let next = try current.applying(changes, dates: dates)
    if let destination = changes.calendarId { event.calendar = try writableCalendar(destination) }
    event.title = next.title
    event.location = next.location
    event.notes = next.notes
    setTimes(event, start: next.start, end: next.end, allDay: next.allDay)
    try commit { try store.save(event, span: ekSpan(span), commit: true) }
    return record(event)
  }

  public func deleteEvent(id: String, span: Span) throws {
    let event = try event(id)
    _ = try writableCalendar(event.calendar?.calendarIdentifier ?? "")
    try commit { try store.remove(event, span: ekSpan(span), commit: true) }
  }

  public func observeChanges(_ onChange: @escaping @Sendable () -> Void) {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    observer = NotificationCenter.default.addObserver(
      forName: .EKEventStoreChanged, object: store, queue: nil
    ) { _ in onChange() }
  }

  /// All-day times arrive with an exclusive end; EventKit wants the last day's final second.
  private func setTimes(_ event: EKEvent, start: Date, end: Date, allDay: Bool) {
    event.isAllDay = allDay
    event.startDate = start
    event.endDate = allDay ? max(start, end.addingTimeInterval(-1)) : end
  }

  private func ekSpan(_ span: Span) -> EKSpan {
    span == .future ? .futureEvents : .thisEvent
  }

  private func recurrenceRule(_ rule: RecurrenceRule) -> EKRecurrenceRule {
    let frequency: EKRecurrenceFrequency
    switch rule.frequency {
    case .daily: frequency = .daily
    case .weekly: frequency = .weekly
    case .monthly: frequency = .monthly
    case .yearly: frequency = .yearly
    }
    var end: EKRecurrenceEnd?
    if let count = rule.count { end = EKRecurrenceEnd(occurrenceCount: count) }
    if let until = rule.until { end = EKRecurrenceEnd(end: until) }
    return EKRecurrenceRule(recurrenceWith: frequency, interval: rule.interval, end: end)
  }

  /// Runs an EventKit write. Its error is reported by domain and code only, since EventKit's
  /// messages can describe the event.
  private func commit(_ write: () throws -> Void) throws {
    do {
      try write()
    } catch {
      let failure = error as NSError
      throw HelperError(
        .internal, "EventKit refused the change (\(failure.domain) \(failure.code))")
    }
  }
}
