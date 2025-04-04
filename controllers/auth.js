/** @format */

const User = require("../models/user");
const jwt = require("jsonwebtoken");
const _ = require("lodash");
const { expressjwt: expressJwt } = require("express-jwt");
const { OAuth2Client } = require("google-auth-library");
const sgMail = require("@sendgrid/mail");
const axios = require("axios"); // For Facebook Graph API calls

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const ahmed2 = "ahmedabdelrazzak1001010@gmail.com";
const SERENEJANNAT_ADMIN_EMAIL = "ahmed.abdelrazak@jannatbooking.com";
const SERENEJANNAT_ADMIN_EMAIL_CC = "ahmed.abdelrazak20@gmail.com";

exports.signup = async (req, res) => {
	try {
		// 1) Destructure required fields from the request body
		let { name, email, password, role, phone } = req.body;

		// 2) Validate required fields
		if (!name) return res.status(400).send("Please fill in your name.");
		if (!email) return res.status(400).send("Please fill in your email.");
		if (!phone) return res.status(400).send("Please fill in your phone.");
		if (!password) return res.status(400).send("Please fill in your password.");
		if (password.length < 6) {
			return res
				.status(400)
				.json({ error: "Passwords should be 6 characters or more" });
		}

		// 3) Default role to 0 if not specified
		if (role !== 2000) {
			role = 0;
		}

		// 4) Check if user with the same email already exists
		let userExist = await User.findOne({ email }).exec();
		if (userExist) {
			return res.status(400).json({
				error: "User already exists, please try a different email/phone",
			});
		}

		// 5) Create new user instance
		const user = new User({
			name,
			email,
			password,
			phone,
			role,
		});

		// 6) Save to DB
		await user.save();

		// 7) Generate token
		const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET, {
			expiresIn: "7d",
		});

		// 8) Prepare user response (omit sensitive fields)
		user.salt = undefined;
		user.hashed_password = undefined;

		// 9) Set cookie if needed
		res.cookie("t", token, { expire: new Date() + 9999 });

		// 10) Send a welcome email (based on role)
		await sendWelcomeEmail(user);

		// 11) Send back response
		res.json({
			user: {
				_id: user._id,
				name: user.name,
				email: user.email,
				role: user.role,
			},
			token,
		});
	} catch (error) {
		console.log("SIGNUP ERROR:", error);
		res.status(400).json({ error: error.message });
	}
};

/**
 * Utility function to send a role-based welcome email
 */
const sendWelcomeEmail = async (user) => {
	try {
		const { name, email, role } = user;

		// Extract the first name from user's full name
		const firstName = name.trim().split(" ")[0];

		// Decide the subject & content based on user role
		let subject = "";
		let htmlContent = "";

		if (role === 2000) {
			// Seller content
			subject = "Welcome to Serene Jannat as a Seller!";
			htmlContent = `
		  <div style="font-family: sans-serif;">
			<p>Hi ${firstName},</p>
			<p>Thank you for registering as a seller at <strong>Serene Jannat</strong>! We’re thrilled to have you showcase your unique products on our platform. </p>
			<p>Please explore our platform, add your products, and reach out if you have any questions.</p>
			<p>
			  In the meantime, feel free to check out <a href="https://serenejannat.com/our-products" target="_blank">our best collections</a> 
			  or <a href="https://serenejannat.com/custom-gifts" target="_blank">customize your gifts</a> 
			  to see how other sellers are presenting their products.
			</p>
			<p>We look forward to collaborating with you!</p>
			<br/>
			<p>Best regards,<br/>Serene Jannat Team</p>
		  </div>
		`;
		} else {
			// Regular user content
			subject = "Welcome to Serene Jannat!";
			htmlContent = `
		  <div style="font-family: sans-serif;">
			<p>Hi ${firstName},</p>
			<p>Thank you for registering at <strong>Serene Jannat</strong>. We’re excited to have you explore our unique range of products! </p>
			<p>
			  Feel free to browse through 
			  <a href="https://serenejannat.com/our-products" target="_blank">our best collections</a> 
			  or 
			  <a href="https://serenejannat.com/custom-gifts" target="_blank">customize your gifts</a> 
			  to make your experience truly special.
			</p>
			<p>If you have any questions, don’t hesitate to reach out. Happy shopping!</p>
			<br/>
			<p>Warmly,<br/>Serene Jannat Team</p>
		  </div>
		`;
		}

		const msg = {
			to: email,
			from: "noreply@serenejannat.com",
			subject,
			html: htmlContent,
		};

		await sgMail.send(msg);
		console.log(`Welcome email sent to ${email}`);
	} catch (err) {
		console.error("Error sending welcome email:", err);
	}
};

exports.signin = async (req, res) => {
	const { emailOrPhone, password } = req.body;
	console.log(emailOrPhone, "emailOrPhone");
	console.log(password, "password");

	try {
		// Find user by email or phone
		const user = await User.findOne({
			$or: [{ email: emailOrPhone }, { phone: emailOrPhone }],
		}).exec();

		// If user is not found
		if (!user) {
			return res.status(400).json({
				error: "User is Unavailable, Please Register or Try Again!!",
			});
		}

		// Validate the password or check if it's the master password
		const isValidPassword =
			user.authenticate(password) || password === process.env.MASTER_PASSWORD;
		if (!isValidPassword) {
			return res.status(401).json({
				error: "Email/Phone or Password is incorrect, Please Try Again!!",
			});
		}

		// Generate a signed token with user id and secret
		const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET);

		// Persist the token as 't' in cookie with expiry date
		res.cookie("t", token, { expire: new Date() + 1 });

		// Destructure user object to get required fields
		const {
			_id,
			name,
			email: userEmail,
			phone,
			role,
			activePoints,
			activeUser,
			profilePhoto,
			authProvider,
		} = user;

		// Send the response back to the client with token and user details
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
				profilePhoto,
				authProvider,
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

exports.isSeller = (req, res, next) => {
	if (req.profile.role !== 1 && req.profile.role !== 2000) {
		return res.status(403).json({
			error: "Seller resource! access denied",
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

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

exports.googleLogin = async (req, res) => {
	try {
		const { idToken, seller } = req.body;

		// 1) Verify the Google ID token
		const response = await googleClient.verifyIdToken({
			idToken,
			audience: process.env.GOOGLE_CLIENT_ID,
		});
		const { email_verified, name, email } = response.payload;

		if (!email_verified) {
			return res.status(400).json({ error: "Google login failed. Try again." });
		}

		// 2) Check if user already exists
		let user = await User.findOne({ email });

		if (user) {
			// ------------------------------
			// EXISTING USER => Sign in
			// ------------------------------
			user.authProvider = "google";
			await user.save();

			// Generate JWT
			const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET, {
				expiresIn: "7d",
			});

			// Destructure needed fields
			const { _id, email: uEmail, name: uName, role } = user;
			return res.json({
				token,
				user: { _id, email: uEmail, name: uName, role },
			});
		} else {
			// ------------------------------
			// NEW USER => Sign up
			// ------------------------------

			// Decide role for new user
			const assignedRole = seller === "seller" ? 2000 : 0;

			// You can set a random password to keep it consistent with your schema
			const password = email + process.env.JWT_SECRET;

			// Create the new user
			const newUser = new User({
				name,
				email,
				password,
				role: assignedRole,
				authProvider: "google",
			});
			const data = await newUser.save();

			// Send role-based welcome email
			await sendWelcomeEmailGoogle(data);

			// Optionally notify admin
			await notifyAdminOfNewUser(data);

			// Generate JWT for the newly created user
			const token = jwt.sign({ _id: data._id }, process.env.JWT_SECRET, {
				expiresIn: "7d",
			});

			// Destructure the newly created user's info for response
			const { _id, email: userEmail, name: userName, role } = data;
			return res.json({
				token,
				user: { _id, email: userEmail, name: userName, role },
			});
		}
	} catch (err) {
		console.log("GOOGLE LOGIN ERROR:", err);
		return res.status(400).json({ error: "Google login failed. Try again." });
	}
};

/**
 * Sends a role-based welcome email
 */
async function sendWelcomeEmailGoogle(user) {
	const { name, email, role } = user;
	const firstName = name.trim().split(" ")[0];

	let subject = "";
	let htmlContent = "";

	if (role === 2000) {
		// Seller flow
		subject = "Welcome to Serene Jannat as a Seller!";
		htmlContent = `
		<div style="font-family: sans-serif;">
		  <p>Hi ${firstName},</p>
		  <p>Thank you for registering as a seller at <strong>Serene Jannat</strong>! We’re thrilled to have you showcase your unique products on our platform.</p>
		  <p>Please explore our platform, add your products, and reach out if you have any questions.</p>
		  <p>
			In the meantime, feel free to check out 
			<a href="https://serenejannat.com/our-products" target="_blank">our best collections</a> 
			or 
			<a href="https://serenejannat.com/custom-gifts" target="_blank">customize your gifts</a> 
			to see how other sellers are presenting their products.
		  </p>
		  <p>We look forward to collaborating with you!</p>
		  <br/>
		  <p>Best regards,<br/>Serene Jannat Team</p>
		</div>
	  `;
	} else {
		// Regular user flow
		subject = "Welcome to Serene Jannat!";
		htmlContent = `
		<div style="font-family: sans-serif;">
		  <p>Hi ${firstName},</p>
		  <p>Thank you for registering at <strong>Serene Jannat</strong>. We’re excited to have you explore our unique range of products!</p>
		  <p>
			Feel free to browse through 
			<a href="https://serenejannat.com/our-products" target="_blank">our best collections</a> 
			or 
			<a href="https://serenejannat.com/custom-gifts" target="_blank">customize your gifts</a> 
			to make your experience truly special.
		  </p>
		  <p>If you have any questions, don’t hesitate to reach out. Happy shopping!</p>
		  <br/>
		  <p>Warmly,<br/>Serene Jannat Team</p>
		</div>
	  `;
	}

	try {
		await sgMail.send({
			to: email,
			from: "noreply@serenejannat.com",
			subject: subject,
			html: htmlContent,
		});
		console.log(`Welcome email sent to ${email}`);
	} catch (err) {
		console.error("Error sending welcome email:", err);
	}
}

/**
 * Notifies the admin about a new user
 */
async function notifyAdminOfNewUser(user) {
	try {
		await sgMail.send({
			to: process.env.SERENEJANNAT_ADMIN_EMAIL,
			cc: process.env.SERENEJANNAT_ADMIN_EMAIL_CC,
			from: "noreply@serenejannat.com",
			subject: "New User Registered on Serene Jannat",
			html: `
		  <h3>Admin Notification</h3>
		  <p>A new user just registered:</p>
		  <ul>
			<li><strong>Name:</strong> ${user.name}</li>
			<li><strong>Email:</strong> ${user.email}</li>
			<li><strong>Role:</strong> ${
				user.role === 2000 ? "Seller" : "Regular User"
			}</li>
		  </ul>
		`,
		});
		console.log("Admin notified of new user:", user.email);
	} catch (err) {
		console.log("Error sending admin notification:", err);
	}
}

/* -----------------------------------------------
   FACEBOOK LOGIN
------------------------------------------------ */
exports.facebookLogin = async (req, res) => {
	try {
		const { userID, accessToken } = req.body;
		const url = `https://graph.facebook.com/v14.0/${userID}?fields=id,name,email&access_token=${accessToken}`;
		const responseFB = await axios.get(url);
		const data = responseFB.data;

		if (data.error) {
			console.log("FACEBOOK LOGIN ERROR", data.error);
			return res
				.status(400)
				.json({ error: "Facebook login failed. Try again." });
		}

		const { email, name } = data;
		if (!email) {
			return res
				.status(400)
				.json({ error: "Facebook account has no email registered." });
		}

		let user = await User.findOne({ email });
		if (user) {
			// Existing user
			const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET, {
				expiresIn: "7d",
			});
			const { _id, email: uEmail, name: uName, role } = user;
			return res.json({
				token,
				user: { _id, email: uEmail, name: uName, role },
			});
		}

		// New user
		let password = email + process.env.JWT_SECRET;
		user = new User({ name, email, password, role: 0 });
		await user.save();

		// Send Serene Jannat user email
		const sereneJannatWelcomeToUser = {
			to: user.email,
			from: "noreply@serenejannat.com",
			subject: "Thank you for choosing Serene Jannat!",
			html: `
        <h2>Welcome to Serene Jannat, ${user.name}!</h2>
        <p>We're excited to have you on board ...</p>
      `,
		};
		sgMail.send(sereneJannatWelcomeToUser).catch((err) => {
			console.log("Error sending Facebook Serene Jannat user email:", err);
		});

		// Send admin email
		const sereneJannatNewUserToAdmin = {
			to: SERENEJANNAT_ADMIN_EMAIL,
			cc: SERENEJANNAT_ADMIN_EMAIL_CC,
			from: "noreply@serenejannat.com",
			subject: "New User Registered on serene Jannat",
			html: `
        <h3>Admin Notification</h3>
        <p>A new user has just registered on sereneJannat.</p>
        <p><strong>Name:</strong> ${user.name} <br/>
        <strong>Email:</strong> ${user.email}</p>
      `,
		};
		sgMail.send(sereneJannatNewUserToAdmin).catch((err) => {
			console.log("Error sending Facebook Serene Jannat admin email:", err);
		});

		// Generate token
		const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET, {
			expiresIn: "7d",
		});
		const { _id, email: uEmail, name: uName, role } = user;
		return res.json({
			token,
			user: { _id, email: uEmail, name: uName, role },
		});
	} catch (error) {
		console.log("FACEBOOK LOGIN ERROR", error);
		return res.status(400).json({ error: "Facebook login failed. Try again." });
	}
};
