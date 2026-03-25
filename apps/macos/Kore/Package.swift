// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Kore",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "Kore",
            path: "Sources/Kore",
            exclude: [
                // Info.plist is used by Xcode for .app bundle creation, not SPM resources
                "Resources/Info.plist"
            ],
            resources: [
                .copy("Resources/Kore.entitlements")
            ]
        )
    ]
)
