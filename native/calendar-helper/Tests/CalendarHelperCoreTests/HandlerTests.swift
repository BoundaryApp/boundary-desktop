import Foundation
import XCTest

@testable import CalendarHelperCore

/// Every test runs against synthetic-calendars/basic.json through FixtureStore. Nothing here
/// touches EventKit or the Mac's real calendars.
final class HandlerTests: XCTestCase {
  private let losAngeles = TimeZone(identifier: "America/Los_Angeles")!

  private static let fixturePath: String = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // CalendarHelperCoreTests
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // calendar-helper
    .deletingLastPathComponent()  // native
    .deletingLastPathComponent()  // repository root
    .appendingPathComponent("synthetic-calendars/basic.json")
    .path

  private var handler: Handler!
  private var nextId = 0

  override func setUpWithError() throws {
    let store = try FixtureStore(path: Self.fixturePath, timeZone: losAngeles)
    handler = Handler(store: store, timeZone: losAngeles)
    nextId = 0
  }

  // MARK: - Helpers

  private func reply(to line: String) throws -> [String: Any] {
    let out = handler.handle(line: line)
    XCTAssertFalse(out.contains("\n"), "a reply must fit on one line")
    let object = try JSONSerialization.jsonObject(with: Data(out.utf8))
    return try XCTUnwrap(object as? [String: Any], "reply is not a JSON object: \(out)")
  }

  private func send(_ op: String, _ params: [String: Any] = [:]) throws -> [String: Any] {
    nextId += 1
    let request: [String: Any] = ["id": nextId, "op": op, "params": params]
    let line = String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self)
    let response = try reply(to: line)
    XCTAssertEqual(response["id"] as? Int, nextId)
    return response
  }

  private func result(_ op: String, _ params: [String: Any] = [:]) throws -> Any {
    let response = try send(op, params)
    XCTAssertEqual(response["ok"] as? Bool, true, "\(op) failed: \(response)")
    return try XCTUnwrap(response["result"], "\(op) has no result")
  }

  private func events(_ op: String, _ params: [String: Any]) throws -> [[String: Any]] {
    try XCTUnwrap(try result(op, params) as? [[String: Any]])
  }

  private func errorCode(_ response: [String: Any]) -> String? {
    XCTAssertEqual(response["ok"] as? Bool, false, "expected an error: \(response)")
    return (response["error"] as? [String: Any])?["code"] as? String
  }

  private let allCalendars = ["cal-icloud-home", "cal-subscribed-home", "cal-birthdays"]

  // MARK: - Tests

  func testListCalendarsReportsKindsAndWritable() throws {
    let calendars = try XCTUnwrap(try result("listCalendars") as? [[String: Any]])
    let byId = Dictionary(uniqueKeysWithValues: calendars.map { ($0["id"] as! String, $0) })

    XCTAssertEqual(byId.count, 3)
    XCTAssertEqual(byId["cal-icloud-home"]?["kind"] as? String, "icloud")
    XCTAssertEqual(byId["cal-icloud-home"]?["writable"] as? Bool, true)
    XCTAssertEqual(byId["cal-icloud-home"]?["color"] as? String, "#1badf8")
    XCTAssertEqual(byId["cal-icloud-home"]?["source"] as? String, "iCloud")
    XCTAssertEqual(byId["cal-subscribed-home"]?["kind"] as? String, "subscribed")
    XCTAssertEqual(byId["cal-subscribed-home"]?["writable"] as? Bool, false)
    XCTAssertEqual(byId["cal-birthdays"]?["kind"] as? String, "birthdays")
    XCTAssertEqual(byId["cal-birthdays"]?["writable"] as? Bool, false)
    XCTAssertEqual(calendars.filter { $0["title"] as? String == "Home" }.count, 2)
  }

  func testListEventsFiltersByCalendarAndRange() throws {
    let found = try events(
      "listEvents",
      [
        "calendarIds": ["cal-icloud-home"],
        "start": "2026-11-10T00:00:00-08:00",
        "end": "2026-11-12T19:00:00-08:00",
      ])
    let summary = found.map { "\($0["title"] as! String) \($0["start"] as! String)" }

    XCTAssertEqual(
      summary,
      [
        "Morning walk 2026-11-10T07:00:00-08:00",
        "Dentist 2026-11-10T10:00:00-08:00",
        "Morning walk 2026-11-11T07:00:00-08:00",
        "Morning walk 2026-11-12T07:00:00-08:00",
        "Dinner planning 2026-11-12T18:30:00-08:00",
      ])
    XCTAssertTrue(found.allSatisfy { $0["calendarId"] as? String == "cal-icloud-home" })

    // The range end is exclusive: an event starting exactly at it is left out.
    let atEnd = try events(
      "listEvents",
      [
        "calendarIds": ["cal-icloud-home"],
        "start": "2026-11-10T08:00:00-08:00",
        "end": "2026-11-10T10:00:00-08:00",
      ])
    XCTAssertEqual(atEnd.count, 0)

    // An empty list of calendars matches nothing.
    let none = try events(
      "listEvents",
      ["calendarIds": [String](), "start": "2026-11-01T00:00:00Z", "end": "2026-12-01T00:00:00Z"])
    XCTAssertEqual(none.count, 0)
  }

  func testStartWithoutOffsetIsReadInLocalZone() throws {
    let created = try XCTUnwrap(
      try result(
        "createEvent",
        [
          "calendarId": "cal-icloud-home",
          "title": "Call the garage",
          "start": "2026-11-12T09:00:00",
          "end": "2026-11-12T09:30:00",
        ]) as? [String: Any])

    XCTAssertEqual(created["start"] as? String, "2026-11-12T09:00:00-08:00")
    XCTAssertEqual(created["end"] as? String, "2026-11-12T09:30:00-08:00")
    XCTAssertEqual(created["allDay"] as? Bool, false)
    XCTAssertEqual(created["recurring"] as? Bool, false)

    // Offsets given by the caller are honoured and reported in the local zone.
    let utc = try XCTUnwrap(
      try result(
        "createEvent",
        [
          "calendarId": "cal-icloud-home",
          "title": "Pick up parcel",
          "start": "2026-11-12T20:00:00Z",
          "end": "2026-11-12T20:15:00Z",
        ]) as? [String: Any])
    XCTAssertEqual(utc["start"] as? String, "2026-11-12T12:00:00-08:00")
  }

  func testAllDayEventsUseDates() throws {
    let fair = try XCTUnwrap(try result("getEvent", ["id": "evt-craft-fair"]) as? [String: Any])
    XCTAssertEqual(fair["start"] as? String, "2026-11-14")
    XCTAssertEqual(fair["end"] as? String, "2026-11-15")
    XCTAssertEqual(fair["allDay"] as? Bool, true)

    let created = try XCTUnwrap(
      try result(
        "createEvent",
        [
          "calendarId": "cal-icloud-home",
          "title": "Long weekend",
          "start": "2026-11-27",
          "end": "2026-11-30",
          "allDay": true,
        ]) as? [String: Any])
    XCTAssertEqual(created["start"] as? String, "2026-11-27")
    XCTAssertEqual(created["end"] as? String, "2026-11-30")
    XCTAssertEqual(created["allDay"] as? Bool, true)

    let attendees = try XCTUnwrap(
      (try result("getEvent", ["id": "evt-dinner"]) as? [String: Any])?["attendees"]
        as? [[String: Any]])
    XCTAssertEqual(attendees.count, 3)
    XCTAssertEqual(attendees[0]["email"] as? String, "rowan@example.com")
    XCTAssertEqual(attendees[1]["status"] as? String, "tentative")
    XCTAssertNil(attendees[2]["name"])
  }

  func testSearchMatchesTitleNotesAndLocationCaseInsensitively() throws {
    let range = ["start": "2026-11-01T00:00:00-08:00", "end": "2026-12-01T00:00:00-08:00"]

    func ids(_ query: String, _ calendars: [String]) throws -> [String] {
      var params: [String: Any] = range
      params["query"] = query
      params["calendarIds"] = calendars
      return try events("search", params).map { $0["id"] as! String }
    }

    XCTAssertEqual(try ids("DENTIST", allCalendars), ["evt-dentist"])  // title
    XCTAssertEqual(try ids("water heater", allCalendars), ["evt-plumber"])  // notes
    XCTAssertEqual(try ids("riverside", allCalendars), ["evt-farmers-market"])  // location
    XCTAssertEqual(try ids("riverside", ["cal-icloud-home"]), [])  // outside the given calendars
    XCTAssertEqual(try ids("no such words", allCalendars), [])
  }

  func testUpdateThisOccurrenceLeavesOthers() throws {
    let range: [String: Any] = [
      "calendarIds": ["cal-icloud-home"],
      "start": "2026-11-09T00:00:00-08:00",
      "end": "2026-11-14T00:00:00-08:00",
    ]
    let walks = try events("listEvents", range).filter { $0["title"] as? String == "Morning walk" }
    XCTAssertEqual(walks.count, 5)
    XCTAssertTrue(walks.allSatisfy { $0["recurring"] as? Bool == true })
    XCTAssertEqual(Set(walks.map { $0["id"] as! String }).count, 5, "each occurrence has its own id")

    let third = walks[2]
    let thirdId = try XCTUnwrap(third["id"] as? String)
    let updated = try XCTUnwrap(
      try result(
        "updateEvent",
        [
          "id": thirdId,
          "span": "this",
          "title": "Late walk",
          "start": "2026-11-11T08:00:00-08:00",
          "end": "2026-11-11T08:45:00-08:00",
        ]) as? [String: Any])
    XCTAssertEqual(updated["id"] as? String, thirdId)
    XCTAssertEqual(updated["title"] as? String, "Late walk")
    XCTAssertEqual(updated["recurring"] as? Bool, true)

    let walkSummary = try events("listEvents", range)
      .filter { ($0["title"] as? String)?.hasSuffix("walk") == true }
      .map { "\($0["title"] as! String) \($0["start"] as! String)" }
    XCTAssertEqual(
      walkSummary,
      [
        "Morning walk 2026-11-09T07:00:00-08:00",
        "Morning walk 2026-11-10T07:00:00-08:00",
        "Late walk 2026-11-11T08:00:00-08:00",
        "Morning walk 2026-11-12T07:00:00-08:00",
        "Morning walk 2026-11-13T07:00:00-08:00",
      ])

    // The changed occurrence keeps its id and can be read back by it.
    let fetched = try XCTUnwrap(try result("getEvent", ["id": thirdId]) as? [String: Any])
    XCTAssertEqual(fetched["title"] as? String, "Late walk")

    // span "future" from the fourth occurrence changes it and the fifth only.
    let fourthId = try XCTUnwrap(walks[3]["id"] as? String)
    _ = try result("updateEvent", ["id": fourthId, "span": "future", "title": "Evening walk"])
    let titles = try events("listEvents", range)
      .compactMap { $0["title"] as? String }
      .filter { $0.hasSuffix("walk") }
    XCTAssertEqual(
      titles, ["Morning walk", "Morning walk", "Late walk", "Evening walk", "Evening walk"])

    // Deleting one occurrence leaves the rest.
    let firstId = try XCTUnwrap(walks[0]["id"] as? String)
    let deleted = try result("deleteEvent", ["id": firstId, "span": "this"]) as? [String: Any]
    XCTAssertEqual(deleted?.count, 0, "deleteEvent replies with {}")
    XCTAssertEqual(errorCode(try send("getEvent", ["id": firstId])), "not_found")
    XCTAssertEqual(
      try events("listEvents", range).filter { ($0["title"] as? String)?.hasSuffix("walk") == true }
        .count, 4)
  }

  func testWriteToSubscribedCalendarIsReadOnlyError() throws {
    XCTAssertEqual(
      errorCode(
        try send(
          "createEvent",
          [
            "calendarId": "cal-subscribed-home",
            "title": "Should not land",
            "start": "2026-11-20T10:00:00-08:00",
            "end": "2026-11-20T11:00:00-08:00",
          ])), "read_only")
    XCTAssertEqual(
      errorCode(try send("updateEvent", ["id": "evt-farmers-market", "span": "this", "title": "x"])),
      "read_only")
    XCTAssertEqual(
      errorCode(try send("deleteEvent", ["id": "evt-farmers-market", "span": "this"])), "read_only")
    // Moving a writable event into a read-only calendar is refused too.
    XCTAssertEqual(
      errorCode(
        try send(
          "updateEvent", ["id": "evt-dentist", "span": "this", "calendarId": "cal-birthdays"])),
      "read_only")

    // Nothing changed.
    let market = try XCTUnwrap(
      try result("getEvent", ["id": "evt-farmers-market"]) as? [String: Any])
    XCTAssertEqual(market["title"] as? String, "Farmers market")
  }

  func testUnknownIdIsNotFound() throws {
    XCTAssertEqual(errorCode(try send("getEvent", ["id": "evt-missing"])), "not_found")
    XCTAssertEqual(
      errorCode(try send("updateEvent", ["id": "evt-missing", "span": "this", "title": "x"])),
      "not_found")
    XCTAssertEqual(errorCode(try send("deleteEvent", ["id": "evt-missing", "span": "this"])), "not_found")
    XCTAssertEqual(errorCode(try send("getEvent", ["id": "evt-walk@12345"])), "not_found")
    XCTAssertEqual(
      errorCode(
        try send(
          "listEvents",
          ["calendarIds": ["cal-missing"], "start": "2026-11-01", "end": "2026-11-02"])),
      "not_found")
  }

  /// Replies in the order they were written, from any thread.
  private final class ReplyLog: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []

    func append(_ line: String) {
      lock.lock()
      lines.append(line)
      lock.unlock()
    }

    func objects() throws -> [[String: Any]] {
      lock.lock()
      let copy = lines
      lock.unlock()
      return try copy.map {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])
      }
    }
  }

  func testPendingRequestAccessDoesNotHoldOtherRequests() throws {
    let store = try FixtureStore(
      path: Self.fixturePath, timeZone: losAngeles, access: .notDetermined)
    store.holdsAccessRequests = true
    let handler = Handler(store: store, timeZone: losAngeles)
    let log = ReplyLog()

    handler.handle(line: #"{"id": 1, "op": "requestAccess", "params": {}}"#) { log.append($0) }
    handler.handle(line: #"{"id": 2, "op": "status", "params": {}}"#) { log.append($0) }

    // The prompt is still open: only status has answered, and access isn't granted yet.
    var replies = try log.objects()
    XCTAssertEqual(replies.map { $0["id"] as? Int }, [2])
    XCTAssertEqual((replies[0]["result"] as? [String: Any])?["access"] as? String, "notDetermined")

    store.answerAccessRequests(with: .granted)

    replies = try log.objects()
    XCTAssertEqual(replies.map { $0["id"] as? Int }, [2, 1])
    XCTAssertEqual(replies[1]["ok"] as? Bool, true)
    XCTAssertEqual((replies[1]["result"] as? [String: Any])?["access"] as? String, "granted")

    let status = handler.handle(line: #"{"id": 3, "op": "status", "params": {}}"#)
    XCTAssertTrue(status.contains(#""access":"granted""#))
  }

  func testRequestAccessAnswersAtOnceWhenAlreadyDecided() throws {
    let access = try XCTUnwrap(try result("requestAccess") as? [String: Any])
    XCTAssertEqual(access["access"] as? String, "granted")
  }

  func testMalformedLineIsInvalidAndHandlerKeepsGoing() throws {
    let garbage = try reply(to: "this is not json")
    XCTAssertEqual(errorCode(garbage), "invalid")
    XCTAssertTrue(garbage["id"] is NSNull, "an unreadable line gets a null id")

    let unknownOp = try reply(to: #"{"id": 41, "op": "explode", "params": {}}"#)
    XCTAssertEqual(unknownOp["id"] as? Int, 41)
    XCTAssertEqual(errorCode(unknownOp), "invalid")

    XCTAssertEqual(
      errorCode(try send("getEvent", [:])), "invalid", "a missing param is invalid")
    XCTAssertEqual(
      errorCode(
        try send(
          "listEvents",
          ["calendarIds": ["cal-icloud-home"], "start": "next tuesday", "end": "2026-11-02"])),
      "invalid")
    XCTAssertEqual(
      errorCode(try send("deleteEvent", ["id": "evt-dentist", "span": "always"])), "invalid")
    XCTAssertEqual(
      errorCode(
        try send(
          "createEvent",
          [
            "calendarId": "cal-icloud-home", "title": "Backwards",
            "start": "2026-11-20T11:00:00-08:00", "end": "2026-11-20T10:00:00-08:00",
          ])), "invalid")

    // Error messages name fields, never the values sent.
    let badDate = try send(
      "listEvents",
      ["calendarIds": ["cal-icloud-home"], "start": "secret words", "end": "2026-11-02"])
    let message = (badDate["error"] as? [String: Any])?["message"] as? String ?? ""
    XCTAssertFalse(message.contains("secret"))

    let status = try XCTUnwrap(try result("status") as? [String: Any])
    XCTAssertEqual(status["access"] as? String, "granted")
  }
}
