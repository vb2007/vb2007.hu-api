import fs from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import supertest from "supertest";
import SwaggerParser from "@apidevtools/swagger-parser";
import { cloneDeep } from "lodash";
import type { OpenAPIV3_1 } from "openapi-types";
import { TestData } from "../constants/testData";
import { Responses } from "../constants/responses";
import { DocsModule, adminSpec, docsModules, publicSpec, root } from "../docs/openapi";
import { createApiKeyToken } from "../helpers/apiKeys";
import { TestUser, createTestUser } from "./helpers/testUsers";

interface Operation {
    key: string;
    path: string;
    pathItem: OpenAPIV3_1.PathItemObject;
    operation: OpenAPIV3_1.OperationObject;
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

const routesOf = (name: string): string[] =>
    mountRouter(name)
        .stack.filter((layer) => layer.route)
        .flatMap(({ route }) =>
            [...new Set(route.stack.map(({ method }) => method))].map(
                (method: string): string => `${method} ${route.path.replace(/:(\w+)/g, "{$1}")}`
            )
        );

const operationsOf = (paths: OpenAPIV3_1.PathsObject = {}): Operation[] =>
    Object.entries(paths).flatMap(([path, pathItem]: [string, OpenAPIV3_1.PathItemObject]) =>
        httpMethods
            .filter((method: string): boolean => method in pathItem)
            .map((method: string): Operation => ({
                key: `${method} ${path}`,
                path,
                pathItem,
                operation: pathItem[method as OpenAPIV3_1.HttpMethods]
            }))
    );

const keysOf = (operations: Operation[]): string[] =>
    operations.map(({ key }: Operation): string => key);

const pathParametersOf = (
    { pathItem, operation }: Operation,
    spec: OpenAPIV3_1.Document
): string[] =>
    [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
        .map(
            (parameter: OpenAPIV3_1.ReferenceObject | OpenAPIV3_1.ParameterObject) =>
                ("$ref" in parameter
                    ? spec.components.parameters[parameter.$ref.split("/").pop()]
                    : parameter) as OpenAPIV3_1.ParameterObject
        )
        .filter((parameter: OpenAPIV3_1.ParameterObject): boolean => parameter.in === "path")
        .map(({ name }: OpenAPIV3_1.ParameterObject): string => name);

const operationProblems = (operation: Operation, spec: OpenAPIV3_1.Document): string[] => {
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
        ...missingParameters.map((name: string): string => `path parameter ${name}`)
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

        it("should document every route of each finished router", (): void => {
            const documented: string[] = keysOf(operationsOf(adminSpec.paths));
            const undocumented: string[] = routerNames
                .filter((name: string): boolean => !docsModules[name].pending)
                .flatMap(routesOf)
                .filter((route: string): boolean => !documented.includes(route));

            expect(undocumented).toEqual([]);
        });

        it("should only document routes that exist", (): void => {
            const routes: string[] = [...appRoutes, ...routerNames.flatMap(routesOf)];
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
                ...(source.tags ?? []).map(
                    ({ name }: OpenAPIV3_1.TagObject): string => `tag ${name}`
                ),
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
        ])(
            "should describe every %s operation completely",
            (_, spec: OpenAPIV3_1.Document): void => {
                expect(
                    operationsOf(spec.paths).flatMap((operation: Operation): string[] =>
                        operationProblems(operation, spec)
                    )
                ).toEqual([]);
            }
        );

        it.each([
            ["public", publicSpec],
            ["admin", adminSpec]
        ])(
            "should be a valid %s OpenAPI 3.1 spec",
            async (_, spec: OpenAPIV3_1.Document): Promise<void> => {
                await expect(SwaggerParser.validate(cloneDeep(spec))).resolves.toBeDefined();
            }
        );
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
