module.exports = {
    preset: "ts-jest",
    testEnvironment: "node",
    testMatch: ["<rootDir>/src/tests/**/*.test.ts"],
    verbose: true,
    collectCoverage: false,
    silent: false,
    // setupFilesAfterEnv: ["<rootDir>/src/tests/setup.ts"],
    reporters: [
        "default",
        [
            "jest-junit",
            {
                outputDirectory: "test-results",
                outputName: "junit.xml",
                suiteName: "Jest Tests"
            }
        ]
    ],
    watchman: false,
    // Ensure console output is captured
    globals: {
        "ts-jest": {
            isolatedModules: true
        }
    }
};
