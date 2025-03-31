/** @format */

const mongoose = require("mongoose");
const crypto = require("crypto");
const { v1: uuidv1 } = require("uuid");
const { ObjectId } = mongoose.Schema;

const userSchema = new mongoose.Schema(
	{
		name: {
			type: String,
			trim: true,
			required: true,
		},

		email: {
			type: String,
			trim: true,
			required: true,
			unique: true,
			lowercase: true,
		},

		phone: {
			type: String,
			trim: true,
			required: true,
		},

		hashed_password: {
			type: String,
			required: true,
		},
		about: {
			type: String,
			trim: true,
		},
		salt: String,
		employeeImage: String,
		role: {
			type: Number,
			default: 0,
		},
		history: {
			type: Array,
			default: [],
		},
		resetPasswordLink: {
			data: {
				type: String,
				default: "",
			},
		},
		likesUser: [{ type: ObjectId, ref: "Product" }],
		points: {
			type: Number,
			default: 0,
		},
		activePoints: {
			type: Number,
			default: 0,
		},
		activeUser: {
			type: Boolean,
			default: true,
		},
		userRole: {
			type: String,
			default: "customer",
		},
		userStore: {
			type: String,
			default: "customer",
		},

		userBranch: {
			type: String,
			default: "",
		},

		profilePhoto: {
			type: Object,
			default: {
				public_id: "",
				url: "",
			},
		},
	},
	{ timestamps: true }
);

// virtual field
userSchema
	.virtual("password")
	.set(function (password) {
		this._password = password;
		this.salt = uuidv1();
		this.hashed_password = this.encryptPassword(password);
	})
	.get(function () {
		return this._password;
	});

userSchema.methods = {
	authenticate: function (plainText) {
		return this.encryptPassword(plainText) === this.hashed_password;
	},

	encryptPassword: function (password) {
		if (!password) return "";
		try {
			return crypto
				.createHmac("sha1", this.salt)
				.update(password)
				.digest("hex");
		} catch (err) {
			return "";
		}
	},
};

module.exports = mongoose.model("User", userSchema);
