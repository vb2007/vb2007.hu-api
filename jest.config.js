module.exports = {
    preset: "ts-jest",
    testEnvironment: "node",
    testMatch: ["<rootDir>/src/tests/**/*.test.ts"],
    verbose: true,
    collectCoverage: false,
    silent: false,
    globalSetup: "<rootDir>/src/tests/setup/globalSetup.ts",
    globalTeardown: "<rootDir>/src/tests/setup/globalTeardown.ts",
    setupFilesAfterEnv: ["<rootDir>/src/tests/setup/database.ts"],
    maxWorkers: "50%",
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
