const baseSiteUrl: string = process.env.BASE_SITE_URL || "https://vb2007.hu";

const hostPattern: RegExp = /^[a-z0-9.-]+(:\d{1,5})?$/i;

export const sharexTokenPlaceholder: string = "vbk_YOUR_TOKEN";

export const isPlainHost = (host: string | undefined): host is string =>
    host !== undefined && hostPattern.test(host);

export const sharexUploaders = (apiUrl: string) => {
    const base = {
        Version: "17.0.0",
        RequestMethod: "POST",
        Headers: { Authorization: `Bearer ${sharexTokenPlaceholder}` },
        ErrorMessage: "{json:error}"
    };

    return {
        upload: {
            ...base,
            Name: "vb2007.hu upload",
            DestinationType: "ImageUploader, FileUploader",
            RequestURL: `${apiUrl}/upload`,
            Body: "MultipartFormData",
            FileFormName: "file",
            Arguments: { visibility: "public" },
            URL: "{json:upload.url}"
        },
        paste: {
            ...base,
            Name: "vb2007.hu paste",
            DestinationType: "TextUploader",
            RequestURL: `${apiUrl}/paste`,
            Body: "JSON",
            Data: '{"paste": "{input}"}',
            URL: `${baseSiteUrl}/pastebin/{json:paste._id}`
        },
        shorten: {
            ...base,
            Name: "vb2007.hu shortener",
            DestinationType: "URLShortener",
            RequestURL: `${apiUrl}/shortenUrl`,
            Body: "JSON",
            Data: '{"url": "{input}"}',
            URL: `${apiUrl}/r/{json:data.shortenedUrl}`
        }
    };
};

export type SharexUploaderName = keyof ReturnType<typeof sharexUploaders>;
