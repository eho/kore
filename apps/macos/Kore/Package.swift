// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Kore",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        // Shared logic — importable by both the app and tests
        .target(
            name: "KoreLib",
            path: "Sources/KoreLib"
        ),

        // App entry point — thin wrapper that depends on KoreLib
        .executableTarget(
            name: "Kore",
            dependencies: ["KoreLib"],
            path: "Sources/Kore",
            exclude: [
                // Info.plist is used by Xcode for .app bundle creation, not SPM resources
                "Resources/Info.plist"
            ],
            resources: [
                .copy("Resources/Kore.entitlements")
            ]
        ),

        // Unit tests for KoreLib
        .testTarget(
            name: "KoreTests",
            dependencies: ["KoreLib"],
            path: "Tests/KoreTests"
        )
    ]
)
