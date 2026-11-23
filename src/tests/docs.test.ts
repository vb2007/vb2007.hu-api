import fs from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import supertest from "supertest";
import SwaggerParser from "@apidevtools/swagger-parser";
import { cloneDeep, isEqual } from "lodash";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { DocsModule, Spec, adminSpec, docsModules, publicSpec, root } from "../docs/openapi";
import { createApiKeyToken } from "../helpers/apiKeys";
import { isAuthenticated, refuseApiKeys } from "../middlewares";
import { limitApiKeyChecks } from "../middlewares/rateLimit";
import { TestUser, createTestUser } from "./helpers/testUsers";

interface Parameter {
    $ref?: string;
    in?: string;
    name?: string;
}

interface OperationObject {
    tags?: string[];
    summary?: string;
    description?: string;
    security?: object[];
    parameters?: Parameter[];
    responses?: object;
}

interface PathItem {
    parameters?: Parameter[];
}

interface Route {
    key: string;
    handles: express.RequestHandler[];
}

interface Operation {
    key: string;
    path: string;
    pathItem: PathItem;
    operation: OperationObject;
}

const routerDir: string = path.join(__dirname, "../router");

const routerNames: string[] = fs
    .readdirSync(routerDir)
    .map((file: string): string => path.basename(file, ".ts"))
    .filter((name: string): boolean => !["index", "docs"].includes(name));

const appRoutes: string[] = ["get /", "get /healthz"];

const httpMethods: string[] = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

const mountRouter = (name: string): express.Router => {
    const router: express.Router = express.Router();
    require(path.join(routerDir, name)).default(router);
    return router;
};

const routesOf = (name: string): Route[] =>
    mountRouter(name)
        .stack.filter((layer) => layer.route)
        .flatMap(({ route }) =>
            [...new Set(route.stack.map(({ method }) => method))].map((method: string): Route => ({
                key: `${method} ${route.path.replace(/:(\w+)/g, "{$1}")}`,
                handles: route.stack.map(({ handle }) => handle)
            }))
        );

const routeKeysOf = (name: string): string[] => routesOf(name).map(({ key }: Route) => key);

const routeHandles: Map<string, express.RequestHandler[]> = new Map(
    routerNames.flatMap(routesOf).map(({ key, handles }: Route) => [key, handles])
);

const operationsOf = (paths: Record<string, object>): Operation[] =>
    Object.entries(paths).flatMap(([path, pathItem]: [string, Record<string, OperationObject>]) =>
        httpMethods
            .filter((method: string): boolean => method in pathItem)
            .map((method: string): Operation => ({
                key: `${method} ${path}`,
                path,
                pathItem,
                operation: pathItem[method]
            }))
    );

const keysOf = (operations: Operation[]): string[] =>
    operations.map(({ key }: Operation): string => key);

const pathParametersOf = ({ pathItem, operation }: Operation, spec: Spec): string[] =>
    [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
        .map((parameter: Parameter): Parameter =>
            parameter.$ref ? spec.components.parameters[parameter.$ref.split("/").pop()] : parameter
        )
        .filter((parameter: Parameter): boolean => parameter.in === "path")
        .map(({ name }: Parameter): string => name);

const authProblems = ({ key, operation: { security = [], responses = {} } }: Operation) => {
    const handles: express.RequestHandler[] = routeHandles.get(key) ?? [];
    const lacks = (status: string): string | false =>
        !(status in responses) && `a ${status} response`;
    const takesApiKey: boolean = security.some((entry: object): boolean => "apiKey" in entry);
    const isLimited: boolean = handles.some((handle) => "resetKey" in handle);

    const problems: (string | false)[] = handles.includes(isAuthenticated)
        ? [!isEqual(security, [{ session: [] }]) && "session-only security", lacks("403")]
        : handles.includes(limitApiKeyChecks)
          ? [
                !(
                    security.some((entry: object): boolean => isEqual(entry, { session: [] })) &&
                    takesApiKey
                ) && "session and API key security",
                lacks("401"),
                lacks("403")
            ]
          : handles.includes(refuseApiKeys)
            ? [takesApiKey && "security without an API key", lacks("403")]
            : [!isEqual(security, []) && "public security"];

    return [...problems, isLimited && lacks("429")];
};

const operationProblems = (operation: Operation, spec: Spec): string[] => {
    const { tags, summary, description, security, responses } = operation.operation;
    const declared: string[] = pathParametersOf(operation, spec);
    const missingParameters: string[] = [...operation.path.matchAll(/\{(\w+)\}/g)]
        .map(([, name]: RegExpMatchArray): string => name)
        .filter((name: string): boolean => !declared.includes(name));

    return [
        !tags?.length && "tags",
        !summary && "summary",
        !description && "description",
        !Array.isArray(security) && "security",
        !Object.keys(responses ?? {}).some((status: string): boolean =>
            /^[23]\d\d$/.test(status)
        ) && "a 2xx or 3xx response",
        !("500" in (responses ?? {})) && "a 500 response",
        ...missingParameters.map((name: string): string => `path parameter ${name}`),
        ...authProblems(operation)
    ]
        .filter(Boolean)
        .map((problem: string): string => `${operation.key}: ${problem}`);
};

const docsSources: DocsModule[] = [root, ...Object.values(docsModules)];

const duplicatesOf = (names: string[]): string[] =>
    names.filter((name: string, index: number): boolean => names.indexOf(name) !== index);

describe("API Docs Tests", (): void => {
    describe("Coverage", (): void => {
        it("should have one docs module per router", (): void => {
            expect(Object.keys(docsModules).sort()).toEqual([...routerNames].sort());
        });

        it("should only find routes in the routers", (): void => {
            for (const name of routerNames) {
                expect(mountRouter(name).stack.every((layer) => layer.route)).toBe(true);
            }
        });

        it("should document every route", (): void => {
            const documented: string[] = keysOf(operationsOf(adminSpec.paths));
            const undocumented: string[] = routerNames
                .flatMap(routeKeysOf)
                .filter((route: string): boolean => !documented.includes(route));

            expect(undocumented).toEqual([]);
        });

        it("should only document routes that exist", (): void => {
            const routes: string[] = [...appRoutes, ...routerNames.flatMap(routeKeysOf)];
            const unknown: string[] = keysOf(operationsOf(adminSpec.paths)).filter(
                (key: string): boolean => !routes.includes(key)
            );

            expect(unknown).toEqual([]);
        });

        it("should document admin routes only in the admin docs module", (): void => {
            const adminPaths: string[] = Object.keys(docsModules.admin.paths);
            const otherPaths: string[] = docsSources
                .filter((source: DocsModule): boolean => source !== docsModules.admin)
                .flatMap((source: DocsModule): string[] => Object.keys(source.paths));

            expect(
                adminPaths.filter((path: string): boolean => !path.startsWith("/admin"))
            ).toEqual([]);
            expect(otherPaths.filter((path: string): boolean => path.startsWith("/admin"))).toEqual(
                []
            );
        });

        it("should keep every admin detail out of the public spec", (): void => {
            expect(JSON.stringify(publicSpec)).not.toContain("/admin");
        });

        it("should not let docs modules override each other", (): void => {
            const names: string[] = docsSources.flatMap((source: DocsModule): string[] => [
                ...keysOf(operationsOf(source.paths)),
                ...(source.tags ?? []).map(({ name }): string => `tag ${name}`),
                ...Object.entries(source.components ?? {}).flatMap(
                    ([section, entries]: [string, object]): string[] =>
                        Object.keys(entries).map((name: string): string => `${section} ${name}`)
                )
            ]);

            expect(duplicatesOf(names)).toEqual([]);
        });
    });

    describe("Spec", (): void => {
        it.each([
            ["public", publicSpec],
            ["admin", adminSpec]
        ])("should describe every %s operation completely", (_, spec: Spec): void => {
            expect(
                operationsOf(spec.paths).flatMap((operation: Operation): string[] =>
                    operationProblems(operation, spec)
                )
            ).toEqual([]);
        });

        it.each([
            ["public", publicSpec],
            ["admin", adminSpec]
        ])("should be a valid %s OpenAPI 3.1 spec", async (_, spec: Spec): Promise<void> => {
            await expect(SwaggerParser.validate(cloneDeep(spec))).resolves.toBeDefined();
        });
    });

    describe("GET /docs", (): void => {
        it("should serve the docs page with a strict CSP", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/docs")
                .expect("Content-Type", /html/)
                .expect(200);

            expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
            expect(response.text).toContain('data-url="/docs/openapi.json"');
        });

        it("should serve the public spec", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get("/docs/openapi.json")
                .expect(200);

            expect(response.body).toEqual(JSON.parse(JSON.stringify(publicSpec)));
            expect(Object.keys(response.body.paths)).not.toContainEqual(
                expect.stringMatching(/^\/admin/)
            );
        });
    });

    describe.each(["/docs/admin", "/docs/admin/openapi.json"])("GET %s", (url: string): void => {
        let user: TestUser;

        beforeAll(async (): Promise<void> => {
            user = await createTestUser("docs");
        });

        it.each([
            [
                "without a session",
                (test: supertest.Test): supertest.Test => test,
                Responses.notLoggedIn
            ],
            [
                "for a user who isn't the superuser",
                (test: supertest.Test): supertest.Test => test.set("Cookie", user.cookie),
                Responses.notAuthorized
            ],
            [
                "with an API key",
                (test: supertest.Test): supertest.Test =>
                    test
                        .set("Cookie", TestData.superuser.cookie)
                        .set("Authorization", `Bearer ${createApiKeyToken()}`),
                Responses.ApiKeys.apiKeyNotAccepted
            ]
        ])(
            "should refuse it %s",
            async (
                _,
                authenticate: (test: supertest.Test) => supertest.Test,
                error: string
            ): Promise<void> => {
                const response: supertest.Response = await authenticate(
                    request(TestData.apiURL).get(url)
                )
                    .expect("Cache-Control", "no-store")
                    .expect(403);

                expect(response.body).toEqual({ error });
            }
        );

        it("should serve it to the superuser", async (): Promise<void> => {
            const response: supertest.Response = await request(TestData.apiURL)
                .get(url)
                .set("Cookie", TestData.superuser.cookie)
                .expect("Cache-Control", "no-store")
                .expect(200);

            if (url.endsWith(".json")) {
                expect(response.body).toEqual(JSON.parse(JSON.stringify(adminSpec)));
            } else {
                expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
                expect(response.text).toContain('data-url="/docs/admin/openapi.json"');
            }
        });
    });
});
