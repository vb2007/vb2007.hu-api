import { ShortUrlModel } from "../database/shortUrls";

const globalIndexName: string = "originalUrl_1";

export const makeShortUrlsPerUser = async (
    model: typeof ShortUrlModel = ShortUrlModel
): Promise<void> => {
    await model.collection.createIndex({ originalUrl: 1, addedBy: 1 }, { unique: true });

    const hasGlobalIndex: boolean = (await model.collection.indexes()).some(
        ({ name }) => name === globalIndexName
    );

    if (!hasGlobalIndex) {
        console.log("Short URLs already unique per user");
        return;
    }

    await model.collection.dropIndex(globalIndexName);

    console.log("Short URLs made unique per user");
};
