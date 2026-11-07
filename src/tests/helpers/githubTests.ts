import { isGithubConfigured } from "../../helpers/github";

export const describeWithGithub: jest.Describe = isGithubConfigured() ? describe : describe.skip;

export const itWithGithub: jest.It = isGithubConfigured() ? it : it.skip;

export const describeWithoutGithub: jest.Describe = isGithubConfigured() ? describe.skip : describe;
