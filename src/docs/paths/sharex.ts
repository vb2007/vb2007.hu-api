import type { DocsModule } from "../openapi";
import { errorResponse, serverError } from "../components";
import { Responses } from "../../constants/responses";
import { SharexUploaderName, sharexTokenPlaceholder, sharexUploaders } from "../../helpers/sharex";

const examples = sharexUploaders("https://api.vb2007.hu");

export const tags: DocsModule["tags"] = [
    {
        name: "ShareX",
        description:
            "Ready-made [ShareX](https://getsharex.com) custom uploaders (`.sxcu` files) for uploads, pastes and short links."
    }
];

const uploaderOperation = (name: SharexUploaderName, summary: string, uses: string): object => ({
    get: {
        tags: ["ShareX"],
        summary,
        description: `Answers the ShareX custom uploader that ${uses}, as a download. Its \`Authorization\` header carries the placeholder \`${sharexTokenPlaceholder}\`: replace it with the token of an API key that has the scope the uploader needs, then import the file in ShareX. The token never goes to this route. The API's own address in the file is taken from the request's \`Host\` header (and \`X-Forwarded-Proto\` from the proxy), so the answer is never cached. The paste and short links use the site's address (\`BASE_SITE_URL\`) instead.`,
        security: [],
        responses: {
            "200": {
                description: "The uploader.",
                headers: {
                    "Content-Disposition": {
                        description: "Makes the browser save it as a file.",
                        schema: {
                            type: "string",
                            example: `attachment; filename="vb2007-${name}.sxcu"`
                        }
                    },
                    "Cache-Control": {
                        description: "Always `private, no-store`.",
                        schema: { type: "string", example: "private, no-store" }
                    }
                },
                content: {
                    "application/json": {
                        schema: { type: "object", description: "A ShareX custom uploader." },
                        example: examples[name]
                    }
                }
            },
            "400": errorResponse(
                "The `Host` header isn't a plain host name with an optional port.",
                Responses.Sharex.invalidHost
            ),
            "500": serverError
        }
    }
});

export const paths: DocsModule["paths"] = {
    "/sharex/upload.sxcu": uploaderOperation(
        "upload",
        "Get the ShareX image and file uploader",
        "sends images and files to `POST /upload` (needs the `uploads:write` scope)"
    ),
    "/sharex/paste.sxcu": uploaderOperation(
        "paste",
        "Get the ShareX text uploader",
        "sends text to `POST /paste` (needs the `pastes:write` scope)"
    ),
    "/sharex/shorten.sxcu": uploaderOperation(
        "shorten",
        "Get the ShareX URL shortener",
        "sends URLs to `POST /shortenUrl` (needs the `shortUrls:write` scope)"
    )
};
