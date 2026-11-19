// swift-tools-version:6.0
import Foundation
import PackageDescription

// The helper embeds an Info.plist so macOS can show the calendar usage text for it. The build
// script points BOUNDARY_CALENDAR_HELPER_PLIST at a copy made for the app being built (its
// bundle id and display name); without it the checked-in Info.plist is used.
let infoPlist =
  ProcessInfo.processInfo.environment["BOUNDARY_CALENDAR_HELPER_PLIST"]
  ?? "\(Context.packageDirectory)/Info.plist"

// The macOS 13 floor is provisional until the calendar access spike confirms it.
let package = Package(
  name: "calendar-helper",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "boundary-calendar-helper", targets: ["boundary-calendar-helper"]),
    .library(name: "CalendarHelperCore", targets: ["CalendarHelperCore"]),
  ],
  targets: [
    .target(
      name: "CalendarHelperCore",
      linkerSettings: [.linkedFramework("EventKit")]
    ),
    .executableTarget(
      name: "boundary-calendar-helper",
      dependencies: ["CalendarHelperCore"],
      linkerSettings: [
        .unsafeFlags([
          "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
          "-Xlinker", infoPlist,
        ])
      ]
    ),
    .testTarget(
      name: "CalendarHelperCoreTests",
      dependencies: ["CalendarHelperCore"]
    ),
  ]
)
