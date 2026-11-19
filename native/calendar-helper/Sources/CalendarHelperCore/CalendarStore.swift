import Foundation

/// One method per protocol op. EventKitStore talks to the Mac's calendars; FixtureStore holds a
/// JSON fixture in memory for tests. Methods throw HelperError for anything the caller should
/// see as an error reply.
public protocol CalendarStore: AnyObject {
  func status() -> AccessStatus
  /// Asks for full calendar access and calls `completion` with the resulting status, from any
  /// thread. It may wait for the person to answer a system prompt, so it must not block.
  func requestAccess(completion: @escaping @Sendable (AccessStatus) -> Void)
  func listCalendars() throws -> [CalendarInfo]
  func listEvents(calendarIds: [String], start: Date, end: Date) throws -> [EventRecord]
  func search(calendarIds: [String], query: String, start: Date, end: Date) throws -> [EventRecord]
  func getEvent(id: String) throws -> EventRecord
  func createEvent(_ draft: EventDraft) throws -> EventRecord
  func updateEvent(id: String, span: Span, changes: EventChanges) throws -> EventRecord
  func deleteEvent(id: String, span: Span) throws
  /// Calls `onChange` whenever the calendar database changes, including after this helper's own
  /// writes.
  func observeChanges(_ onChange: @escaping @Sendable () -> Void)
}

/// The subset of RFC 5545 RRULE the helper accepts: FREQ (DAILY, WEEKLY, MONTHLY, YEARLY),
/// INTERVAL, and COUNT or UNTIL. Anything else is refused as invalid rather than dropped.
public struct RecurrenceRule: Equatable, Sendable {
  public enum Frequency: String, Sendable {
    case daily = "DAILY", weekly = "WEEKLY", monthly = "MONTHLY", yearly = "YEARLY"

    var component: Calendar.Component {
      switch self {
      case .daily: return .day
      case .weekly: return .weekOfYear
      case .monthly: return .month
      case .yearly: return .year
      }
    }
  }

  public var frequency: Frequency
  public var interval: Int
  public var count: Int?
  public var until: Date?

  public init(frequency: Frequency, interval: Int = 1, count: Int? = nil, until: Date? = nil) {
    self.frequency = frequency
    self.interval = interval
    self.count = count
    self.until = until
  }

  /// Parses "FREQ=WEEKLY;INTERVAL=2;COUNT=4", with or without a leading "RRULE:". A date-only
  /// UNTIL covers that whole local day.
  public static func parse(_ text: String, timeZone: TimeZone) throws -> RecurrenceRule {
    var body = text.trimmingCharacters(in: .whitespaces)
    if body.uppercased().hasPrefix("RRULE:") { body = String(body.dropFirst(6)) }
    var frequency: Frequency?
    var interval = 1
    var count: Int?
    var until: Date?
    for part in body.split(separator: ";") {
      let pieces = part.split(separator: "=", maxSplits: 1).map(String.init)
      guard pieces.count == 2 else { throw HelperError(.invalid, "params.rrule is malformed") }
      let key = pieces[0].uppercased()
      let value = pieces[1]
      switch key {
      case "FREQ":
        guard let parsed = Frequency(rawValue: value.uppercased()) else {
          throw HelperError(.invalid, "params.rrule FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY")
        }
        frequency = parsed
      case "INTERVAL":
        guard let parsed = Int(value), parsed > 0 else {
          throw HelperError(.invalid, "params.rrule INTERVAL must be a positive integer")
        }
        interval = parsed
      case "COUNT":
        guard let parsed = Int(value), parsed > 0 else {
          throw HelperError(.invalid, "params.rrule COUNT must be a positive integer")
        }
        count = parsed
      case "UNTIL":
        guard let parsed = parseUntil(value, timeZone: timeZone) else {
          throw HelperError(.invalid, "params.rrule UNTIL must be YYYYMMDD or YYYYMMDDTHHMMSSZ")
        }
        until = parsed
      default:
        // Only the part name is echoed, and it is limited to letters by the check below.
        let name = key.allSatisfy { $0.isLetter } ? key : "?"
        throw HelperError(.invalid, "params.rrule part \(name) isn't supported")
      }
    }
    guard let frequency else { throw HelperError(.invalid, "params.rrule needs FREQ") }
    if count != nil && until != nil {
      throw HelperError(.invalid, "params.rrule can't have both COUNT and UNTIL")
    }
    return RecurrenceRule(frequency: frequency, interval: interval, count: count, until: until)
  }

  private static func parseUntil(_ value: String, timeZone: TimeZone) -> Date? {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    if value.count == 8 {
      formatter.timeZone = timeZone
      formatter.dateFormat = "yyyyMMdd"
      guard let day = formatter.date(from: value) else { return nil }
      var calendar = Calendar(identifier: .gregorian)
      calendar.timeZone = timeZone
      return calendar.date(byAdding: .day, value: 1, to: day)?.addingTimeInterval(-1)
    }
    formatter.timeZone = TimeZone(identifier: "UTC")
    formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
    return formatter.date(from: value)
  }
}

/// Converts between protocol strings and instants in one time zone.
public struct WireDates: Sendable {
  public let timeZone: TimeZone

  public init(timeZone: TimeZone) {
    self.timeZone = timeZone
  }

  public var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    return calendar
  }

  /// Accepts ISO 8601 with an offset or "Z", a local date-time without one, or a date.
  public func parse(_ text: String) -> Date? {
    let offsetFormats: [ISO8601DateFormatter.Options] = [
      [.withInternetDateTime],
      [.withInternetDateTime, .withFractionalSeconds],
    ]
    for options in offsetFormats {
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = options
      if let date = formatter.date(from: text) { return date }
    }
    let local = DateFormatter()
    local.locale = Locale(identifier: "en_US_POSIX")
    local.timeZone = timeZone
    for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss.SSS", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd"] {
      local.dateFormat = format
      if let date = local.date(from: text) { return date }
    }
    return nil
  }

  public func format(_ date: Date, allDay: Bool) -> String {
    if allDay {
      let formatter = DateFormatter()
      formatter.locale = Locale(identifier: "en_US_POSIX")
      formatter.timeZone = timeZone
      formatter.dateFormat = "yyyy-MM-dd"
      return formatter.string(from: date)
    }
    let formatter = ISO8601DateFormatter()
    formatter.timeZone = timeZone
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.string(from: date)
  }

  public func startOfDay(_ date: Date) -> Date {
    calendar.startOfDay(for: date)
  }

  /// The exclusive end of an all-day span whose last instant is just before `end`: the midnight
  /// after the day that holds `end - 1s`, or `start`'s next midnight when `end` is not after it.
  public func allDayEnd(start: Date, end: Date) -> Date {
    let lastDay = end > start ? startOfDay(end.addingTimeInterval(-1)) : startOfDay(start)
    return calendar.date(byAdding: .day, value: 1, to: lastDay) ?? lastDay
  }

  public func toWire(_ record: EventRecord) -> Event {
    Event(
      id: record.id,
      calendarId: record.calendarId,
      title: record.title,
      start: format(record.start, allDay: record.allDay),
      end: format(record.end, allDay: record.allDay),
      allDay: record.allDay,
      location: record.location,
      notes: record.notes,
      url: record.url,
      recurring: record.recurring,
      attendees: record.attendees
    )
  }
}

extension EventRecord {
  /// This record with `changes` applied: all-day times are snapped to whole days, and an end
  /// before the start is refused. Empty location or notes clear the field.
  public func applying(_ changes: EventChanges, dates: WireDates) throws -> EventRecord {
    var next = self
    if let calendarId = changes.calendarId { next.calendarId = calendarId }
    if let title = changes.title { next.title = title }
    if let location = changes.location { next.location = location.isEmpty ? nil : location }
    if let notes = changes.notes { next.notes = notes.isEmpty ? nil : notes }
    if let allDay = changes.allDay { next.allDay = allDay }
    let duration = end.timeIntervalSince(start)
    if let newStart = changes.start {
      next.start = newStart
      // Moving the start without an end keeps the length.
      if changes.end == nil { next.end = newStart.addingTimeInterval(duration) }
    }
    if let newEnd = changes.end { next.end = newEnd }
    guard next.end >= next.start else {
      throw HelperError(.invalid, "params.end is before params.start")
    }
    if next.allDay {
      next.end = dates.allDayEnd(start: next.start, end: next.end)
      next.start = dates.startOfDay(next.start)
    } else if allDay && changes.end == nil && changes.start == nil {
      // An all-day event made timed keeps its day and becomes an hour long.
      next.end = next.start.addingTimeInterval(3600)
    }
    return next
  }
}
