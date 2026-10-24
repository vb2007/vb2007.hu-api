import mongoose from "mongoose";

const UserSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        minlength: 2,
        maxlength: 16,
        unique: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        match: /^\S+@\S+\.\S+$/,
        unique: true
    },
    authentication: {
        password: {
            type: String,
            select: false //for avoiding fetching sensitive user credentials by accident
        },
        salt: {
            type: String,
            select: false
        },
        sessionToken: {
            type: String,
            select: false
        }
    },
    githubId: {
        type: String,
        unique: true,
        sparse: true
    },
    githubLogin: {
        type: String
    },
    uploadQuotaBytes: {
        type: Number,
        default: null,
        select: false
    },
    createdAt: {
        type: Date,
        default: Date.now,
        immutable: true
    }
});

export const UserModel = mongoose.model("User", UserSchema);

export const getUserByEmail = (email: string) => UserModel.findOne({ email: { $eq: email } });

export const getUserByUsername = (username: string) =>
    UserModel.findOne({ username: { $eq: username } });

export const getUserByGithubId = (githubId: string) =>
    UserModel.findOne({ githubId: { $eq: githubId } });

export const getUserBySessionToken = (sessionToken: string) =>
    UserModel.findOne({
        "authentication.sessionToken": { $eq: sessionToken }
    });

export const getUserById = (id: string) => UserModel.findById(id);

export const getUserUploadQuota = (id: mongoose.Types.ObjectId | string) =>
    UserModel.findById(id).select("+uploadQuotaBytes").lean();

export const createUser = (values: Record<string, any>) =>
    new UserModel(values).save().then((user) => user.toObject());

export const deleteUserById = (id: string) => UserModel.findByIdAndDelete({ _id: id });

export const updateUserById = (id: string, values: Record<string, any>) =>
    UserModel.findByIdAndUpdate(id, values);
