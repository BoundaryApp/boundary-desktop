// boundary-calendar-helper: JSON lines on stdin and stdout (see Protocol.swift).
//
//   boundary-calendar-helper                    the Mac's calendars through EventKit
//   boundary-calendar-helper --fixture <path>   a JSON fixture held in memory
//
// stdin is read on a background queue while the main run loop keeps running, so EventKit's
// change notifications are delivered. The helper exits when stdin closes. stderr carries usage
// and startup failures only, never calendar or event content.

import CalendarHelperCore
import Foundation

/// Writes whole lines to stdout, one at a time, from any thread.
final class LineWriter: @unchecked Sendable {
  private let lock = NSLock()

  func write(_ line: String) {
    lock.lock()
    defer { lock.unlock() }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
  }
}

/// Owns the handler on the input queue, its only caller.
final class InputLoop: @unchecked Sendable {
  private let handler: Handler
  private let output: LineWriter

  init(handler: Handler, output: LineWriter) {
    self.handler = handler
    self.output = output
  }

  func run() {
    while let line = readLine(strippingNewline: true) {
      if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
      // requestAccess replies later from EventKit's callback; reading carries on meanwhile.
      handler.handle(line: line) { [output] reply in output.write(reply) }
    }
    exit(0)
  }
}

func fail(_ message: String, code: Int32) -> Never {
  FileHandle.standardError.write(Data("boundary-calendar-helper: \(message)\n".utf8))
  exit(code)
}

func makeStore(_ arguments: [String]) -> CalendarStore {
  switch arguments.count {
  case 0:
    return EventKitStore()
  case 2 where arguments[0] == "--fixture":
    do {
      return try FixtureStore(path: arguments[1])
    } catch let error as HelperError {
      fail(error.message, code: 66)
    } catch {
      fail("the fixture couldn't be loaded", code: 66)
    }
  default:
    fail("usage: boundary-calendar-helper [--fixture <path>]", code: 64)
  }
}

let output = LineWriter()
let store = makeStore(Array(CommandLine.arguments.dropFirst()))
store.observeChanges { output.write(changedEventLine) }
let loop = InputLoop(handler: Handler(store: store), output: output)
DispatchQueue(label: "boundary-calendar-helper.input").async { loop.run() }
RunLoop.main.run()
