/** @format */

const cloudinary = require("cloudinary");

// config
cloudinary.config({
	cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
	api_key: process.env.CLOUDINARY_API_KEY,
	api_secret: process.env.CLOUDINARY_API_SECRET,
});

// req.files.file.path
exports.upload = async (req, res) => {
	let result = await cloudinary.v2.uploader.upload(req.body.image, {
		public_id: `serene_janat/${Date.now()}`,
		resource_type: "auto", // jpeg, png
	});
	res.json({
		public_id: result.public_id,
		url: result.secure_url,
	});
};

exports.remove = (req, res) => {
	let image_id = req.body.public_id;
	console.log(image_id);
	cloudinary.uploader.destroy(image_id, (err, result) => {
		if (err) return res.json({ success: false, err });
		res.send("ok");
	});
};

exports.uploadCommentImage = async (req, res) => {
	let result = await cloudinary.uploader.upload(req.body.image, {
		public_id: `${Date.now()}`,
		resource_type: "auto", // jpeg, png
	});
	res.json({
		public_id: result.public_id,
		url: result.secure_url,
	});
};

exports.removeCommentImage = (req, res) => {
	let image_id = req.body.public_id;

	cloudinary.uploader.destroy(image_id, (err, result) => {
		if (err) return res.json({ success: false, err });
		res.send("ok");
	});
};

exports.uploadForPOD = async (req, res) => {
	try {
		const result = await cloudinary.uploader.upload(req.body.image, {
			public_id: `serene_janat/${Date.now()}`,
			resource_type: "auto", // let Cloudinary handle the format
		});

		// Return the public_id & secure_url to the client
		return res.json({
			public_id: result.public_id,
			url: result.secure_url,
		});
	} catch (err) {
		console.error("Cloudinary upload error:", err);
		return res.status(400).json({ error: "Upload to Cloudinary failed" });
	}
};

/**
 * 3) REMOVE (General)
 *    Expects req.body.public_id
 *    Removes the image from Cloudinary
 */
exports.removeForPOD = (req, res) => {
	let image_id = req.body.public_id;
	// For debugging:
	console.log("Removing image:", image_id);

	cloudinary.uploader.destroy(image_id, (err, result) => {
		if (err) {
			console.error("Cloudinary remove error:", err);
			return res.json({ success: false, err });
		}
		// Or return any JSON you prefer:
		res.json({ success: true, result });
	});
};
