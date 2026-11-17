import { definePrismaConfig } from "prisma/config";
import { defineConfig as ormConfig } from "@prisma/orm-mongo/config";

export default definePrismaConfig({
    orm: ormConfig({ contract: "./src/prisma/contract.prisma" })
});
