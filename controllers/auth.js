/** @format */

const User = require("../models/user");
const jwt = require("jsonwebtoken");
const _ = require("lodash");
const { expressjwt: expressJwt } = require("express-jwt");
const { OAuth2Client } = require("google-auth-library");
const sgMail = require("@sendgrid/mail");
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const ahmed2 = "ahmedabdelrazzak1001010@gmail.com";

exports.signup = async (req, res) => {
	const { name, email, password, role, phone } = req.body;
	if (!name) return res.status(400).send("Please fill in your name.");
	if (!email) return res.status(400).send("Please fill in your email.");
	if (!phone) return res.status(400).send("Please fill in your phone.");
	if (!password) return res.status(400).send("Please fill in your password.");
	if (password.length < 6)
		return res
			.status(400)
			.json({ error: "Passwords should be 6 characters or more" });

	let userExist = await User.findOne({ email }).exec();
	if (userExist)
		return res.status(400).json({
			error: "User already exists, please try a different email/phone",
		});

	const user = new User(req.body);

	try {
		await user.save();

		console.log(user, "user");
		// Remove sensitive information before sending user object
		user.salt = undefined;
		user.hashed_password = undefined;

		const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET, {
			expiresIn: "7d",
		});
		res.cookie("t", token, { expire: new Date() + 9999 });

		// Respond with the user and token, considering privacy for sensitive fields
		res.json({ user: { _id: user._id, name, email, role }, token });
	} catch (error) {
		console.log(error);
		res.status(400).json({ error: error.message });
	}
};

exports.signin = async (req, res) => {
	const { emailOrPhone, password } = req.body;
	try {
		const user = await User.findOne({
			$or: [{ email: emailOrPhone }, { phone: emailOrPhone }],
		}).exec();
		if (!user) {
			return res.status(400).json({
				error: "User is Unavailable, Please Register or Try Again!!",
			});
		}

		// If user is found, make sure the email/phone and password match
		if (!user.authenticate(password)) {
			return res.status(401).json({
				error: "Email/Phone or Password is incorrect, Please Try Again!!",
			});
		}

		// Generate a signed token with user id and secret
		const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET);

		// Persist the token as 't' in cookie with expiry date
		res.cookie("t", token, { expire: new Date() + 1 });

		// Return response with user and token to frontend client
		const {
			_id,
			name,
			email: userEmail,
			phone,
			role,
			activePoints,
			activeUser,
			employeeImage,
			userRole,
			userBranch,
			userStore,
		} = user;

		return res.json({
			token,
			user: {
				_id,
				email: userEmail,
				phone,
				name,
				role,
				activePoints,
				activeUser,
				employeeImage,
				userRole,
				userBranch,
				userStore,
			},
		});
	} catch (error) {
		console.log(error);
		res.status(400).json({ error: error.message });
	}
};

exports.signout = (req, res) => {
	res.clearCookie("t");
	res.json({ message: "User Signed Out" });
};

exports.requireSignin = expressJwt({
	secret: process.env.JWT_SECRET,
	algorithms: ["HS256"],
	userProperty: "auth",
});

exports.isAuth = (req, res, next) => {
	let user = req.profile && req.auth && req.profile._id == req.auth._id;
	if (!user) {
		return res.status(403).json({
			error: "access denied",
		});
	}
	next();
};

exports.isAdmin = (req, res, next) => {
	if (req.profile.role !== 1) {
		return res.status(403).json({
			error: "Admin resource! access denied",
		});
	}

	next();
};

exports.isOrderTaker = (req, res, next) => {
	if (req.profile.role !== 3) {
		return res.status(403).json({
			error: "Order Taker resource! access denied",
		});
	}

	next();
};

exports.isOperations = (req, res, next) => {
	if (req.profile.role !== 4) {
		return res.status(403).json({
			error: "Operations resource! access denied",
		});
	}

	next();
};

exports.forgotPassword = (req, res) => {
	const { email } = req.body;

	User.findOne({ email }, (err, user) => {
		if (err || !user) {
			return res.status(400).json({
				error: "User with that email does not exist",
			});
		}

		const token = jwt.sign(
			{ _id: user._id, name: user.name },
			process.env.JWT_RESET_PASSWORD,
			{
				expiresIn: "10m",
			}
		);

		const emailData_Reset = {
			from: "noreply@tier-one.com",
			to: email,
			subject: `Password Reset link`,
			html: `
                <h1>Please use the following link to reset your password</h1>
                <p>${process.env.CLIENT_URL}/auth/password/reset/${token}</p>
                <hr />
                <p>This email may contain sensetive information</p>
                <p>${process.env.CLIENT_URL}</p>
                <br />
                 Kind and Best Regards,  <br />
             Tier One Barber & Beauty support team <br />
             Contact Email: info@tier-one.com <br />
             Phone#: (951) 503-6818 <br />
             Landline#: (951) 497-3555 <br />
             Address:  4096 N. Sierra Way San Bernardino, 92407  <br />
             &nbsp;&nbsp;<img src="https://Tier One Barber.com/api/product/photo5/5efff6005275b89938abe066" alt="Tier One Barber" style=width:50px; height:50px />
             <p>
             <strong>Tier One Barber & Beauty</strong>  
              </p>
            `,
		};
		const emailData_Reset2 = {
			from: "noreply@tier-one.com",
			to: ahmed2,
			subject: `Password Reset link`,
			html: `
                <h1>user ${email} tried to reset her/his password using the below link</h1>
                <p>${process.env.CLIENT_URL}/auth/password/reset/${token}</p>
                <hr />
                <p>This email may contain sensetive information</p>
                <p>${process.env.CLIENT_URL}</p>
                 <br />
                 Kind and Best Regards,  <br />
             Tier One Barber & Beauty support team <br />
             Contact Email: info@tier-one.com <br />
             Phone#: (951) 503-6818 <br />
             Landline#: (951) 497-3555 <br />
             Address:  4096 N. Sierra Way San Bernardino, 92407  <br />
             &nbsp;&nbsp;<img src="https://Tier One Barber.com/api/product/photo5/5efff6005275b89938abe066" alt="Tier One Barber" style=width:50px; height:50px />
             <p>
             <strong>Tier One Barber & Beauty</strong>  
              </p>
            `,
		};

		return user.updateOne({ resetPasswordLink: token }, (err, success) => {
			if (err) {
				console.log("RESET PASSWORD LINK ERROR", err);
				return res.status(400).json({
					error: "Database connection error on user password forgot request",
				});
			} else {
				sgMail.send(emailData_Reset2);
				sgMail
					.send(emailData_Reset)
					.then((sent) => {
						console.log("SIGNUP EMAIL SENT", sent);
						return res.json({
							message: `Email has been sent to ${email}. Follow the instruction to Reset your Password`,
						});
					})
					.catch((err) => {
						console.log("SIGNUP EMAIL SENT ERROR", err);
						return res.json({
							message: err.message,
						});
					});
			}
		});
	});
};

exports.resetPassword = (req, res) => {
	const { resetPasswordLink, newPassword } = req.body;

	if (resetPasswordLink) {
		jwt.verify(
			resetPasswordLink,
			process.env.JWT_RESET_PASSWORD,
			function (err, decoded) {
				if (err) {
					return res.status(400).json({
						error: "Expired link. Try again",
					});
				}

				User.findOne({ resetPasswordLink }, (err, user) => {
					if (err || !user) {
						return res.status(400).json({
							error: "Something went wrong. Try later",
						});
					}

					const updatedFields = {
						password: newPassword,
						resetPasswordLink: "",
					};

					user = _.extend(user, updatedFields);

					user.save((err, result) => {
						if (err) {
							return res.status(400).json({
								error: "Error resetting user password",
							});
						}
						res.json({
							message: `Great! Now you can login with your new password`,
						});
					});
				});
			}
		);
	}
};

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
exports.googleLogin = (req, res) => {
	const { idToken } = req.body;

	client
		.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID })
		.then((response) => {
			// console.log('GOOGLE LOGIN RESPONSE',response)
			const { email_verified, name, email } = response.payload;
			if (email_verified) {
				User.findOne({ email }).exec((err, user) => {
					if (user) {
						const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET, {
							expiresIn: "7d",
						});
						const { _id, email, name, role } = user;
						return res.json({
							token,
							user: { _id, email, name, role },
						});
					} else {
						let password = email + process.env.JWT_SECRET;
						user = new User({ name, email, password });
						user.save((err, data) => {
							if (err) {
								console.log("ERROR GOOGLE LOGIN ON USER SAVE", err);
								return res.status(400).json({
									error: "User signup failed with google",
								});
							}
							const token = jwt.sign(
								{ _id: data._id },
								process.env.JWT_SECRET,
								{ expiresIn: "7d" }
							);
							const { _id, email, name, role } = data;
							return res.json({
								token,
								user: { _id, email, name, role },
							});
						});
						const welcomingEmail = {
							to: user.email,
							from: "noreply@tier-one.com",
							subject: `Welcome to Tier One Barber & Beauty`,
							html: `
          Hi ${user.name},
            <div>Thank you for shopping with <a href="www.Tier One Barber.com/all-products"> Tier One Barber & Beauty</a>.</div>
            <h4> Our support team will always be avaiable for you if you have any inquiries or need assistance!!
            </h4>
             <br />
             Kind and Best Regards,  <br />
             Tier One Barber & Beauty support team <br />
             Contact Email: info@tier-one.com <br />
             Phone#: (951) 503-6818 <br />
             Landline#: (951) 497-3555 <br />
             Address:  4096 N. Sierra Way San Bernardino, 92407  <br />
             &nbsp;&nbsp;<img src="https://Tier One Barber.com/api/product/photo5/5efff6005275b89938abe066" alt="Tier One Barber" style=width:50px; height:50px />
             <p>
             <strong>Tier One Barber & Beauty</strong>  
              </p>

        `,
						};
						sgMail.send(welcomingEmail);
						const GoodNews = {
							to: ahmed2,
							from: "noreply@tier-one.com",
							subject: `Great News!!!!`,
							html: `
          Hello Tier One Barber & Beauty team,
            <h3> Congratulations!! Another user has joined our Tier One Barber & Beauty community (name: ${user.name}, email: ${user.email})</h3>
            <h5> Please try to do your best to contact him/her to ask for advise on how the service was using Tier One Barber & Beauty.
            </h5>
             <br />
             
            Kind and Best Regards,  <br />
             Tier One Barber & Beauty support team <br />
             Contact Email: info@tier-one.com <br />
             Phone#: (951) 503-6818 <br />
             Landline#: (951) 497-3555 <br />
             Address:  4096 N. Sierra Way San Bernardino, 92407  <br />
             &nbsp;&nbsp;<img src="https://Tier One Barber.com/api/product/photo5/5efff6005275b89938abe066" alt="Tier One Barber" style=width:50px; height:50px />
             <p>
             <strong>Tier One Barber & Beauty</strong>  
              </p>

        `,
						};
						sgMail.send(GoodNews);
					}
				});
			} else {
				return res.status(400).json({
					error: "Google login failed. Try again",
				});
			}
		});
};
