import Foundation

/// Turns one request line into one reply line. It holds no state of its own beyond the store,
/// and never writes to stdout or stderr.
public final class Handler {
  private let store: CalendarStore
  private let dates: WireDates

  public init(store: CalendarStore, timeZone: TimeZone = .current) {
    self.store = store
    self.dates = WireDates(timeZone: timeZone)
  }

  /// Answers one request line by calling `respond` exactly once. Every op answers before this
  /// returns except `requestAccess`, which answers when the store has the person's answer, from
  /// whatever thread the store calls back on. Later lines can be handled in the meantime.
  public func handle(line: String, respond: @escaping @Sendable (String) -> Void) {
    var id: Int?
    do {
      let request = try readRequest(line)
      id = request.id
      if request.op == .requestAccess {
        let requestId = request.id
        store.requestAccess { access in
          respond(
            Handler.encode(
              Reply(id: requestId, ok: true, result: AccessReply(access: access), error: nil)))
        }
        return
      }
      let result = try dispatch(request.op, params: request.params)
      respond(Self.encode(Reply(id: id, ok: true, result: result, error: nil)))
    } catch let failure as RequestError {
      respond(Self.encode(Reply(id: failure.id, ok: false, result: nil, error: failure.error)))
    } catch let error as HelperError {
      respond(Self.encode(Reply(id: id, ok: false, result: nil, error: error)))
    } catch {
      let failure = HelperError(.internal, "Unexpected error")
      respond(Self.encode(Reply(id: id, ok: false, result: nil, error: failure)))
    }
  }

  /// Answers one request line and returns the reply. For `requestAccess` this waits until the
  /// store answers, so the helper's input loop uses `handle(line:respond:)` instead.
  public func handle(line: String) -> String {
    let reply = ReplySlot()
    let answered = DispatchSemaphore(value: 0)
    handle(line: line) { text in
      reply.set(text)
      answered.signal()
    }
    answered.wait()
    return reply.get()
  }

  private final class ReplySlot: @unchecked Sendable {
    private let lock = NSLock()
    private var text = ""

    func set(_ value: String) {
      lock.lock()
      text = value
      lock.unlock()
    }

    func get() -> String {
      lock.lock()
      defer { lock.unlock() }
      return text
    }
  }

  // MARK: - Reading requests

  private struct Request {
    let id: Int
    let op: Op
    let params: Data
  }

  /// Reads the envelope by hand so that a bad op or params can still be answered with the id.
  private func readRequest(_ line: String) throws -> Request {
    guard
      let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)),
      let fields = object as? [String: Any]
    else { throw HelperError(.invalid, "The request line isn't a JSON object") }
    guard let number = fields["id"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
      let id = Int(exactly: number.doubleValue)
    else { throw HelperError(.invalid, "The request has no numeric id") }

    guard let opName = fields["op"] as? String, let op = Op(rawValue: opName) else {
      // An unknown op is answered with the id so the caller can match the failure.
      throw RequestError(id: id, error: HelperError(.invalid, "Unknown op"))
    }
    let params = fields["params"] ?? [String: Any]()
    guard params is [String: Any], let data = try? JSONSerialization.data(withJSONObject: params)
    else { throw RequestError(id: id, error: HelperError(.invalid, "params must be an object")) }
    return Request(id: id, op: op, params: data)
  }

  /// A failure found after the id was read.
  private struct RequestError: Error {
    let id: Int
    let error: HelperError
  }

  private func decode<P: Decodable>(_ type: P.Type, _ data: Data) throws -> P {
    do {
      return try JSONDecoder().decode(type, from: data)
    } catch let DecodingError.keyNotFound(key, context) {
      throw HelperError(.invalid, "\(fieldPath(context.codingPath + [key])) is missing")
    } catch let DecodingError.typeMismatch(_, context) {
      throw HelperError(.invalid, "\(fieldPath(context.codingPath)) has the wrong type")
    } catch let DecodingError.valueNotFound(_, context) {
      throw HelperError(.invalid, "\(fieldPath(context.codingPath)) is null")
    } catch {
      throw HelperError(.invalid, "params couldn't be read")
    }
  }

  private func fieldPath(_ path: [CodingKey]) -> String {
    (["params"] + path.map { $0.intValue.map { "[\($0)]" } ?? $0.stringValue })
      .joined(separator: ".")
  }

  private func date(_ text: String, _ field: String) throws -> Date {
    guard let date = dates.parse(text) else {
      throw HelperError(.invalid, "params.\(field) isn't an ISO 8601 date or date-time")
    }
    return date
  }

  private func optionalDate(_ text: String?, _ field: String) throws -> Date? {
    try text.map { try date($0, field) }
  }

  private func span(_ text: String) throws -> Span {
    guard let span = Span(rawValue: text) else {
      throw HelperError(.invalid, #"params.span must be "this" or "future""#)
    }
    return span
  }

  private func range(_ start: String, _ end: String) throws -> (Date, Date) {
    let from = try date(start, "start")
    let to = try date(end, "end")
    guard to >= from else { throw HelperError(.invalid, "params.end is before params.start") }
    return (from, to)
  }

  // MARK: - Ops

  private struct RangeParams: Decodable {
    let calendarIds: [String]
    let start: String
    let end: String
  }

  private struct SearchParams: Decodable {
    let calendarIds: [String]
    let query: String
    let start: String
    let end: String
  }

  private struct IdParams: Decodable {
    let id: String
  }

  private struct CreateParams: Decodable {
    let calendarId: String
    let title: String
    let start: String
    let end: String
    let allDay: Bool?
    let location: String?
    let notes: String?
    let rrule: String?
  }

  private struct UpdateParams: Decodable {
    let id: String
    let span: String
    let calendarId: String?
    let title: String?
    let start: String?
    let end: String?
    let allDay: Bool?
    let location: String?
    let notes: String?
  }

  private struct DeleteParams: Decodable {
    let id: String
    let span: String
  }

  private struct EmptyResult: Encodable {}

  private func dispatch(_ op: Op, params data: Data) throws -> any Encodable {
    switch op {
    case .status:
      return AccessReply(access: store.status())
    case .requestAccess:
      // Answered asynchronously in handle(line:respond:) and never dispatched here.
      throw HelperError(.internal, "requestAccess reached the synchronous path")
    case .listCalendars:
      try requireReadAccess()
      return try store.listCalendars()
    case .listEvents:
      let params = try decode(RangeParams.self, data)
      let (start, end) = try range(params.start, params.end)
      try requireReadAccess()
      return try store.listEvents(calendarIds: params.calendarIds, start: start, end: end)
        .map(dates.toWire)
    case .search:
      let params = try decode(SearchParams.self, data)
      let (start, end) = try range(params.start, params.end)
      try requireReadAccess()
      return try store.search(
        calendarIds: params.calendarIds, query: params.query, start: start, end: end
      ).map(dates.toWire)
    case .getEvent:
      let params = try decode(IdParams.self, data)
      try requireReadAccess()
      return dates.toWire(try store.getEvent(id: params.id))
    case .createEvent:
      let params = try decode(CreateParams.self, data)
      let draft = try makeDraft(params)
      try requireWriteAccess()
      return dates.toWire(try store.createEvent(draft))
    case .updateEvent:
      let params = try decode(UpdateParams.self, data)
      let span = try span(params.span)
      if let title = params.title, title.trimmingCharacters(in: .whitespaces).isEmpty {
        throw HelperError(.invalid, "params.title is empty")
      }
      let changes = EventChanges(
        calendarId: params.calendarId,
        title: params.title,
        start: try optionalDate(params.start, "start"),
        end: try optionalDate(params.end, "end"),
        allDay: params.allDay,
        location: params.location,
        notes: params.notes
      )
      try requireReadAccess()
      return dates.toWire(try store.updateEvent(id: params.id, span: span, changes: changes))
    case .deleteEvent:
      let params = try decode(DeleteParams.self, data)
      let span = try span(params.span)
      try requireReadAccess()
      try store.deleteEvent(id: params.id, span: span)
      return EmptyResult()
    }
  }

  private func makeDraft(_ params: CreateParams) throws -> EventDraft {
    if params.title.trimmingCharacters(in: .whitespaces).isEmpty {
      throw HelperError(.invalid, "params.title is empty")
    }
    var (start, end) = try range(params.start, params.end)
    let allDay = params.allDay ?? false
    if allDay {
      end = dates.allDayEnd(start: start, end: end)
      start = dates.startOfDay(start)
    }
    return EventDraft(
      calendarId: params.calendarId,
      title: params.title,
      start: start,
      end: end,
      allDay: allDay,
      location: params.location.flatMap { $0.isEmpty ? nil : $0 },
      notes: params.notes.flatMap { $0.isEmpty ? nil : $0 },
      recurrence: try params.rrule.map { try RecurrenceRule.parse($0, timeZone: dates.timeZone) }
    )
  }

  private func requireReadAccess() throws {
    let access = store.status()
    guard access == .granted else {
      throw HelperError(.denied, "Calendar access is \(access.rawValue)")
    }
  }

  private func requireWriteAccess() throws {
    let access = store.status()
    guard access == .granted || access == .writeOnly else {
      throw HelperError(.denied, "Calendar access is \(access.rawValue)")
    }
  }

  // MARK: - Writing replies

  private struct Reply: Encodable {
    let id: Int?
    let ok: Bool
    let result: (any Encodable)?
    let error: HelperError?

    enum CodingKeys: String, CodingKey { case id, ok, result, error }
    enum ErrorKeys: String, CodingKey { case code, message }

    func encode(to encoder: Encoder) throws {
      var container = encoder.container(keyedBy: CodingKeys.self)
      try container.encode(id, forKey: .id)  // null when the line had no readable id
      try container.encode(ok, forKey: .ok)
      if let result { try container.encode(result, forKey: .result) }
      if let error {
        var nested = container.nestedContainer(keyedBy: ErrorKeys.self, forKey: .error)
        try nested.encode(error.code, forKey: .code)
        try nested.encode(error.message, forKey: .message)
      }
    }
  }

  private static func encode(_ reply: Reply) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    if let data = try? encoder.encode(reply) {
      return String(decoding: data, as: UTF8.self)
    }
    let fallback = Reply(
      id: reply.id, ok: false, result: nil,
      error: HelperError(.internal, "The reply couldn't be encoded"))
    return (try? encoder.encode(fallback)).map { String(decoding: $0, as: UTF8.self) }
      ?? #"{"error":{"code":"internal","message":"The reply couldn't be encoded"},"id":null,"ok":false}"#
  }
}
