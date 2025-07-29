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
                outputDirectory: "./src/tests/reports",
                outputName: "junit.xml",
                suiteName: "Jest Tests"
            }
        ]
    ],
    watchman: false,
    globals: {
        "ts-jest": {
            isolatedModules: true
        }
    }
};
