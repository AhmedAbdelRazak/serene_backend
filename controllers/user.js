/** @format */

const User = require("../models/user");
const { Order } = require("../models/order");

exports.userById = async (req, res, next, id) => {
	console.log(id, "id");
	try {
		const user = await User.findById(id)
			.select(
				"_id name email role phone user points activePoints likesUser activeUser employeeImage userRole history userStore userBranch"
			)
			.populate({
				path: "likesUser",
				populate: {
					path: "category",
					select: "_id name",
				},
			})
			.exec();

		if (!user) {
			return res.status(400).json({
				error: "user not found yad",
			});
		}
		req.profile = user;
		next();
	} catch (err) {
		console.log(err);
		return res.status(400).json({
			error: "user not found yad",
		});
	}
};

exports.updatedUserId = (req, res, next, id) => {
	User.findById(id)
		.select(
			"_id name email role user points activePoints likesUser activeUser employeeImage userRole history userStore userBranch"
		)

		.exec((err, userNeedsUpdate) => {
			console.log(err, "user not found yad");
			if (err || !userNeedsUpdate) {
				return res.status(400).json({
					error: "user not found yad",
				});
			}
			req.updatedUserByAdmin = userNeedsUpdate;
			next();
		});
};

exports.read = (req, res) => {
	req.profile.hashed_password = undefined;
	req.profile.salt = undefined;
	return res.json(req.profile);
};

exports.update = async (req, res) => {
	const { name, email, phone, password } = req.body;

	try {
		let user = await User.findOne({ _id: req.profile._id });
		if (!user) {
			return res.status(400).json({
				error: "User not found",
			});
		}
		if (!name) {
			return res.status(400).json({
				error: "Name is required",
			});
		} else {
			user.name = name;
		}

		if (email) {
			user.email = email;
		}

		if (phone) {
			user.phone = phone;
		}

		if (password) {
			if (password.length < 6) {
				return res.status(400).json({
					error: "Password should be min 6 characters long",
				});
			} else {
				user.password = password;
			}
		}

		let updatedUser = await user.save();
		updatedUser.hashed_password = undefined;
		updatedUser.salt = undefined;
		res.json(updatedUser);
	} catch (err) {
		console.log("USER UPDATE ERROR", err);
		return res.status(400).json({
			error: "User update failed",
		});
	}
};

exports.remove = (req, res) => {
	let user = req.user;
	user.remove((err, deletedUser) => {
		if (err) {
			return res.status(400).json({
				error: errorHandler(err),
			});
		}
		res.json({
			manage: "User was successfully deleted",
		});
	});
};

exports.allUsersList = (req, res) => {
	User.find()
		.select(
			"_id name email role user points activePoints likesUser activeUser employeeImage userRole history userStore userBranch"
		)
		.exec((err, users) => {
			if (err) {
				return res.status(400).json({
					error: "users not found",
				});
			}
			res.json(users);
		});
};

exports.addOrderToUserHistory = (req, res, next) => {
	console.log(req.body.order, "from user add to user history");

	User.findOneAndUpdate(
		{ _id: req.profile._id },
		{ $push: { history: req.body.order } },
		{ new: true },
		(error, data) => {
			if (error) {
				return res.status(400).json({
					error: "Could not update user purchase history",
				});
			}
			next();
		}
	);
};

exports.purchaseHistory = (req, res) => {
	Order.find({ user: req.profile._id })
		.populate("user", "_id name points activePoints")

		.sort("-created")
		.exec((err, orders) => {
			if (err) {
				return res.status(400).json({
					error: "error retriving purchase history of user",
				});
			}
			res.json(orders);
		});
};

exports.increasePoints = (req, res, next) => {
	console.log(req.body.order, "From inceasing points");
	let flag = Number(req.body.order.LoyaltyPoints);
	let flag2 = Number(req.body.order.LoyaltyPoints);

	if (
		req.profile.activePoints >= req.body.order.minLoyaltyPointsForAward &&
		req.body.order.applyPoints === true
	) {
		flag2 = -req.body.order.minLoyaltyPointsForAward;
	}

	User.findOneAndUpdate(
		{
			_id: req.profile._id,
		},
		{
			$inc: {
				points: flag,
				activePoints: flag2,
			},
		},

		{ new: true },
		function (err, response) {
			if (err) {
				console.log(err, "error from points update");
			}
			console.log(req.profile.points, req.profile.activePoints);
			next();
		}
	);
};

exports.like = (req, res) => {
	User.findByIdAndUpdate(
		req.body.userId,
		{ $push: { likesUser: req.body.productId } },
		{ new: true }
	)
		.populate("likesUser", "_id productName")

		.exec((err, result) => {
			if (err) {
				return res.status(400).json({
					error: err,
				});
			} else {
				res.json(result);
			}
		});
};

exports.unlike = (req, res) => {
	User.findByIdAndUpdate(
		req.body.userId,
		{ $pull: { likesUser: req.body.productId } },
		{ new: true }
	).exec((err, result) => {
		if (err) {
			return res.status(400).json({
				error: err,
			});
		} else {
			res.json(result);
		}
	});
};

exports.updateUserByAdmin = (req, res) => {
	const {
		name,
		password,
		role,
		activeUser,
		employeeImage,
		email,
		userRole,
		userStore,
		userBranch,
	} = req.body.updatedUserByAdmin;

	User.findOne({ _id: req.body.updatedUserByAdmin.userId }, (err, user) => {
		if (err || !user) {
			return res.status(400).json({
				error: "User not found",
			});
		}
		if (!name) {
			return res.status(400).json({
				error: "Name is required",
			});
		} else {
			user.name = name;
		}

		if (password) {
			if (password.length < 6) {
				return res.status(400).json({
					error: "Password should be min 6 characters long",
				});
			} else {
				user.password = password;
			}
		}

		if (!role) {
			return res.status(400).json({
				error: "Role is required",
			});
		} else {
			user.role = role;
		}

		if (!email) {
			return res.status(400).json({
				error: "Email is required",
			});
		} else {
			user.email = email;
		}

		if (!activeUser) {
			return res.status(400).json({
				error: "activeUser is required",
			});
		} else {
			user.activeUser = activeUser;
		}

		if (!employeeImage) {
			return res.status(400).json({
				error: "employeeImage is required",
			});
		} else {
			user.employeeImage = employeeImage;
		}

		if (!userRole) {
			return res.status(400).json({
				error: "User Role Is Required",
			});
		} else {
			user.userRole = userRole;
		}

		if (!userStore) {
			return res.status(400).json({
				error: "User Store Is Required",
			});
		} else {
			user.userStore = userStore;
		}

		if (!userBranch) {
			return res.status(400).json({
				error: "User Store Is Required",
			});
		} else {
			user.userBranch = userBranch;
		}

		user.save((err, updatedUser) => {
			if (err) {
				console.log("USER UPDATE ERROR", err);
				return res.status(400).json({
					error: "User update failed",
				});
			}
			updatedUser.hashed_password = undefined;
			updatedUser.salt = undefined;
			res.json(updatedUser);
		});
	});
};
