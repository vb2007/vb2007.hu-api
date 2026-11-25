import fs from "fs";
import path from "path";

interface Workflow {
    file: string;
    source: string;
}

const ciRunsOn: string[] = ["runs-on: [self-hosted, ci]"];

const workflowDir: string = path.join(__dirname, "../../.github/workflows");

const workflows: Workflow[] = fs
    .readdirSync(workflowDir)
    .filter((file: string): boolean => /\.ya?ml$/.test(file))
    .map((file: string): Workflow => ({
        file,
        source: fs.readFileSync(path.join(workflowDir, file), "utf8")
    }));

const topLevelSection = (source: string, key: string): string =>
    source.match(new RegExp(`^["']?${key}["']?:.*(?:\\r?\\n(?:[ \\t#].*)?)*`, "m"))?.[0] ?? "";

const runsOnLines = (job: string): string[] =>
    (job.match(/^\s*runs-on:.*$/gm) ?? []).map((line: string): string => line.trim());

const runsOnByJob = (source: string): Record<string, string[]> =>
    Object.fromEntries(
        topLevelSection(source, "jobs")
            .split(/^ {2}(?=[\w-]+:)/m)
            .slice(1)
            .map((job: string): [string, string[]] => [job.split(":")[0], runsOnLines(job)])
    );

const pullRequestWorkflows: Workflow[] = workflows.filter(({ source }: Workflow): boolean =>
    /\bpull_request/.test(topLevelSection(source, "on"))
);

describe("Workflows triggered by pull requests", () => {
    test("exist", () => {
        expect(pullRequestWorkflows.length).toBeGreaterThan(0);
    });

    test.each(pullRequestWorkflows)("$file runs every job on the ci runners only", ({ source }) => {
        const runsOn: Record<string, string[]> = runsOnByJob(source);
        const jobIds: string[] = Object.keys(runsOn);

        expect(jobIds.length).toBeGreaterThan(0);
        expect(runsOn).toEqual(
            Object.fromEntries(jobIds.map((id: string): [string, string[]] => [id, ciRunsOn]))
        );
    });
});
