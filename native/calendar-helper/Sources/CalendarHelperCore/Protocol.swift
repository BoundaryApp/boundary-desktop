import Foundation

// The JSON-lines protocol between Boundary's main process and this helper. Each request is one
// line on stdin and gets exactly one reply line on stdout, carrying the request's id:
//
//   request  {"id": 1, "op": "listEvents", "params": {...}}
//   success  {"id": 1, "ok": true, "result": ...}
//   failure  {"id": 1, "ok": false, "error": {"code": "not_found", "message": "..."}}
//
// A line that can't be read as a request gets a failure with "id": null. The helper also writes
// {"event": "changed"} on its own when the calendar database changes.
//
// Times: a timed event's start and end are ISO 8601 with an offset, in the helper's time zone.
// An all-day event's start and end are dates (YYYY-MM-DD); the end date is exclusive, so a
// one-day event on 14 November reads start "2026-11-14", end "2026-11-15". A time sent without
// an offset is read in the helper's time zone.
//
// Error messages name fields and ids only, never event titles, notes, locations or attendees,
// so the caller may log them.

public enum Op: String, Sendable {
  case status, requestAccess, listCalendars, listEvents, search, getEvent
  case createEvent, updateEvent, deleteEvent
}

public enum AccessStatus: String, Codable, Sendable {
  case notDetermined, denied, restricted, granted, writeOnly
}

public struct AccessReply: Codable, Sendable {
  public let access: AccessStatus
}

public enum CalendarKind: String, Codable, Sendable {
  case icloud, google, exchange, caldav, subscribed, birthdays, local, other
}

public struct CalendarInfo: Codable, Equatable, Sendable {
  public var id: String
  public var title: String
  /// "#rrggbb"
  public var color: String
  /// The account the calendar belongs to, as macOS names it ("iCloud", "Other", an address).
  public var source: String
  public var kind: CalendarKind
  public var writable: Bool

  public init(
    id: String, title: String, color: String, source: String, kind: CalendarKind, writable: Bool
  ) {
    self.id = id
    self.title = title
    self.color = color
    self.source = source
    self.kind = kind
    self.writable = writable
  }
}

public struct Attendee: Codable, Equatable, Sendable {
  public var name: String?
  public var email: String?
  /// unknown, pending, accepted, declined, tentative, delegated, completed or inProcess
  public var status: String

  public init(name: String?, email: String?, status: String) {
    self.name = name
    self.email = email
    self.status = status
  }
}

/// An event or one occurrence of a recurring event, with times as instants. All-day events
/// have `start` at local midnight and an exclusive `end` at the midnight after their last day.
public struct EventRecord: Equatable, Sendable {
  public var id: String
  public var calendarId: String
  public var title: String
  public var start: Date
  public var end: Date
  public var allDay: Bool
  public var location: String?
  public var notes: String?
  public var url: String?
  public var recurring: Bool
  public var attendees: [Attendee]

  public init(
    id: String, calendarId: String, title: String, start: Date, end: Date, allDay: Bool,
    location: String? = nil, notes: String? = nil, url: String? = nil, recurring: Bool = false,
    attendees: [Attendee] = []
  ) {
    self.id = id
    self.calendarId = calendarId
    self.title = title
    self.start = start
    self.end = end
    self.allDay = allDay
    self.location = location
    self.notes = notes
    self.url = url
    self.recurring = recurring
    self.attendees = attendees
  }

  /// Search: the query appears in the title, notes or location, ignoring case.
  public func matches(query: String) -> Bool {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if needle.isEmpty { return false }
    return [title, notes, location].contains { field in
      field?.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) != nil
    }
  }

  /// Overlaps [start, end). A zero-length event counts when it sits inside the range.
  public func overlaps(start rangeStart: Date, end rangeEnd: Date) -> Bool {
    if start >= rangeEnd { return false }
    if end == start { return start >= rangeStart }
    return end > rangeStart
  }
}

/// The wire form of an event.
public struct Event: Codable, Equatable, Sendable {
  public var id: String
  public var calendarId: String
  public var title: String
  public var start: String
  public var end: String
  public var allDay: Bool
  public var location: String?
  public var notes: String?
  public var url: String?
  public var recurring: Bool
  public var attendees: [Attendee]
}

public struct EventDraft: Sendable {
  public var calendarId: String
  public var title: String
  public var start: Date
  public var end: Date
  public var allDay: Bool
  public var location: String?
  public var notes: String?
  public var recurrence: RecurrenceRule?
}

/// Fields to change. nil leaves a field as it is; an empty location or notes string clears it.
public struct EventChanges: Sendable {
  public var calendarId: String?
  public var title: String?
  public var start: Date?
  public var end: Date?
  public var allDay: Bool?
  public var location: String?
  public var notes: String?
}

/// Which occurrences of a recurring event a change or delete applies to. Ignored for events
/// that don't repeat.
public enum Span: String, Codable, Sendable {
  case this, future
}

public enum ErrorCode: String, Codable, Sendable {
  case denied
  case notFound = "not_found"
  case invalid
  case readOnly = "read_only"
  case `internal`
}

public struct HelperError: Error, Equatable, Sendable {
  public let code: ErrorCode
  public let message: String

  public init(_ code: ErrorCode, _ message: String) {
    self.code = code
    self.message = message
  }

  static func eventNotFound(_ id: String) -> HelperError {
    HelperError(.notFound, "No event with id \(id)")
  }

  static func calendarNotFound(_ id: String) -> HelperError {
    HelperError(.notFound, "No calendar with id \(id)")
  }

  static func readOnlyCalendar(_ id: String) -> HelperError {
    HelperError(.readOnly, "Calendar \(id) is read-only")
  }
}

/// The unprompted message sent when the calendar database changes.
public let changedEventLine = #"{"event":"changed"}"#
