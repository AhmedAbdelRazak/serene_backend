/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const productSchema = new mongoose.Schema(
	{
		productName: {
			type: String,
			trim: true,
			required: true,
			maxlength: 200,
			text: true,
			lowercase: true,
		},

		productName_Arabic: {
			type: String,
			trim: true,
			maxlength: 200,
			text: true,
			lowercase: true,
		},
		productSKU: {
			type: String,
			trim: true,
			required: true,
			maxlength: 100,
			text: true,
			lowercase: true,
		},
		productUPC: {
			type: Number,
			trim: true,
			maxlength: 100,
		},
		slug: {
			type: String,
			unique: true,
			lowercase: true,
			index: true,
			required: true,
		},
		slug_Arabic: {
			type: String,
			unique: true,
			lowercase: true,
			index: true,
		},
		description: {
			type: String,
			required: true,
			text: true,
		},
		description_Arabic: {
			type: String,
			maxlength: 2000,
			text: true,
		},
		policy: {
			type: String,
			default: "",
			text: true,
		},
		policy_Arabic: {
			type: String,
			default: "",
			text: true,
		},
		DNA: {
			type: String,
			default: "",
			text: true,
		},
		DNA_Arabic: {
			type: String,
			default: "",
			text: true,
		},
		Specs: {
			type: String,
			default: "",
			text: true,
		},
		Specs_Arabic: {
			type: String,
			default: "",
			text: true,
		},
		fitCare: {
			type: String,
			default: "",
			text: true,
		},
		fitCare_Arabic: {
			type: String,
			default: "",
			text: true,
		},

		price: {
			type: Number,
			required: true,
			trim: true,
			maxlength: 32,
		},
		priceAfterDiscount: {
			type: Number,
			required: true,
			trim: true,
			maxlength: 32,
		},

		MSRPPriceBasic: {
			type: Number,
			required: true,
			trim: true,
			maxlength: 32,
		},
		WholeSalePriceBasic: {
			type: Number,
			default: 0,
		},
		DropShippingPriceBasic: {
			type: Number,
			default: 0,
		},

		price_unit: {
			type: String,
			trim: true,
			maxlength: 32,
			default: "LE",
		},
		parentName: {
			type: ObjectId,
			ref: "Parent",
			default: null,
		},
		loyaltyPoints: {
			type: Number,
			trim: true,
			maxlength: 32,
			default: 10,
		},
		category: {
			type: ObjectId,
			ref: "Category",
			required: true,
		},
		subcategory: [
			{
				type: ObjectId,
				ref: "Subcategory",
				default: null,
			},
		],
		gender: {
			type: ObjectId,
			ref: "Gender",
			default: null,
		},
		addedByEmployee: {
			type: ObjectId,
			ref: "User",
			default: null,
		},
		updatedByEmployee: {
			type: ObjectId,
			ref: "User",
			default: null,
		},
		quantity: Number,

		scent: {
			type: String,
			default: "",
		},

		sold: {
			type: Number,
			default: 0,
		},

		thumbnailImage: {
			type: Array,
		},

		geodata: {
			type: Object,
			default: {
				length: "",
				width: "",
				height: "",
				weight: "",
			},
		},

		relatedProducts: [
			{
				type: ObjectId,
				ref: "Product",
			},
		],

		shipping: {
			type: Boolean,
			default: true,
		},

		addVariables: {
			type: Boolean,
			default: false,
		},

		clearance: {
			type: Boolean,
			default: false,
		},

		chosenSeason: {
			type: String,
		},

		color: {
			type: String,
			default: "",
		},

		size: {
			type: String,
			default: "",
		},

		productAttributes: [
			{
				PK: {
					type: String,
				},
				color: {
					type: String,
				},
				productImages: {
					type: Array,
				},
				size: String,
				SubSKU: String,

				quantity: {
					type: Number,
					default: 0,
				},
				receivedQuantity: {
					type: Number,
					default: 0,
				},
				price: {
					type: Number,
					default: 0,
				},
				priceAfterDiscount: {
					type: Number,
					default: 0,
				},
				MSRP: {
					type: Number,
					default: 0,
				},
				WholeSalePrice: {
					type: Number,
					default: 0,
				},
				DropShippingPrice: {
					type: Number,
					default: 0,
				},
			},
		],

		activeProduct: {
			type: Boolean,
			default: true,
		},
		activeBackorder: {
			type: Boolean,
			default: true,
		},
		featuredProduct: {
			type: Boolean,
			default: false,
		},

		sizeChart: {
			type: Object,
			default: {},
		},

		isPrintifyProduct: {
			type: Boolean,
			default: false, //Here it should be true if it's a printify
		},

		printifyProductDetails: {
			type: Object,
			default: {
				//it should here contain relevant parts of the printifyProduct object
				//It should contain the likes of the price, description and images and other relevant product
			},
		},

		likes: [{ type: ObjectId, ref: "User" }],
		views: [],
		viewsCount: {
			type: Number,
			default: 0,
		},

		comments: [
			{
				text: String,
				commentsPhotos: {
					type: Array,
				},
				created: { type: Date, default: Date.now },
				postedBy: { type: ObjectId, ref: "User" },
			},
		],
		ratings: [
			{
				star: Number,
				ratedOn: { type: Date, default: Date.now },
				ratedBy: { type: ObjectId, ref: "User" },
			},
		],
	},
	{ timestamps: true }
);

module.exports = mongoose.model("Product", productSchema);
