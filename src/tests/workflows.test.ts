import fs from "fs";
import path from "path";

interface Workflow {
    file: string;
    source: string;
}

const workflowDir: string = path.join(__dirname, "../../.github/workflows");

const workflows: Workflow[] = fs
    .readdirSync(workflowDir)
    .filter((file: string): boolean => /\.ya?ml$/.test(file))
    .map((file: string): Workflow => ({
        file,
        source: fs.readFileSync(path.join(workflowDir, file), "utf8")
    }));

const topLevelSection = (source: string, key: string): string =>
    source.match(new RegExp(`^["']?${key}["']?:.*(?:\\n(?:[ \\t].*)?)*`, "m"))?.[0] ?? "";

const jobBlocks = (source: string): string[] =>
    topLevelSection(source, "jobs")
        .split(/^ {2}(?=[\w-]+:)/m)
        .slice(1);

const runsOnLines = (job: string): string[] =>
    (job.match(/^\s*runs-on:.*$/gm) ?? []).map((line: string): string => line.trim());

const pullRequestWorkflows: Workflow[] = workflows.filter(({ source }: Workflow): boolean =>
    /\bpull_request(_target)?\b/.test(topLevelSection(source, "on"))
);

describe("Workflows triggered by pull requests", () => {
    test("exist", () => {
        expect(pullRequestWorkflows.length).toBeGreaterThan(0);
    });

    test.each(pullRequestWorkflows)("$file runs every job on the ci runners only", ({ source }) => {
        const jobs: string[] = jobBlocks(source);

        expect(jobs.length).toBeGreaterThan(0);
        for (const job of jobs) {
            expect(runsOnLines(job)).toEqual(["runs-on: [self-hosted, ci]"]);
        }
        expect(source).not.toMatch(/(?:[[,]|^\s*-)\s*["']?host\b/m);
    });
});
