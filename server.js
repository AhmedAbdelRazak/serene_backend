/** @format */

const express = require("express");
const mongoose = require("mongoose");
require("dotenv").config();
const morgan = require("morgan");
const cors = require("cors");
const { readdirSync } = require("fs");

const http = require("http");
const socketIo = require("socket.io");
const cron = require("node-cron");
const axios = require("axios");

// You can override this in .env if needed, otherwise localhost:8101
const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:8101";

// app
const app = express();

const stripeController = require("./controllers/stripeController");
app.post(
	"/api/stripe/webhook",
	express.raw({ type: "application/json" }), // <‑‑ no json/body‑parser here
	stripeController.webhook
);

const server = http.createServer(app);

// db
mongoose.set("strictQuery", false);
mongoose
	.connect(process.env.DATABASE)
	.then(() => console.log("MongoDB Atlas is connected"))
	.catch((err) => console.log("DB Connection Error: ", err));

// middlewares
app.use(morgan("dev"));
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => {
	res.send("Hello From ecommerce API");
});

// Create the io instance
const io = socketIo(server, {
	cors: {
		origin: "*",
		methods: ["GET", "POST"],
		allowedHeaders: ["Authorization"],
		credentials: true,
	},
});

// Pass the io instance to the app
app.set("io", io);
global.io = io;

// routes middlewares
readdirSync("./routes").map((r) => app.use("/api", require(`./routes/${r}`)));

// ========== CRON JOBS ==========

// Existing Printify sync (every ~59 minutes)
cron.schedule("*/59 * * * *", async () => {
	try {
		console.log("Running scheduled task to fetch Printify orders");
		await axios.get(`${API_BASE_URL}/api/get-printify-orders`);
		console.log("Orders Updated From Printify");
	} catch (error) {
		console.error(
			"Error during scheduled Printify task:",
			error.message || error
		);
	}
});

// AI marketing campaign audits (every 3 hours)
// Fires at minute 0 of every 3rd hour (00:00, 03:00, 06:00, ...)
cron.schedule("0 */3 * * *", async () => {
	try {
		console.log("Running scheduled AI marketing campaign audits");
		await axios.get(`${API_BASE_URL}/api/ai/campaigns/run-due-audits`);
		console.log("AI marketing audits completed");
	} catch (error) {
		console.error(
			"Error during scheduled AI marketing audit task:",
			error.message || error
		);
	}
});

const port = process.env.PORT || 8101;

server.listen(port, () => {
	console.log(`Server is running on port ${port}`);
});

// ===== SOCKET.IO EVENT HANDLING =====
io.on("connection", (socket) => {
	console.log("A user connected:", socket.id);

	/**
	 * Join a specific room (caseId)
	 */
	socket.on("joinRoom", ({ caseId }) => {
		if (caseId) {
			socket.join(caseId);
			console.log(`Socket ${socket.id} joined room: ${caseId}`);
		}
	});

	/**
	 * Leave the room (caseId) on command
	 */
	socket.on("leaveRoom", ({ caseId }) => {
		if (caseId) {
			socket.leave(caseId);
			console.log(`Socket ${socket.id} left room: ${caseId}`);
		}
	});

	/**
	 * Handle user typing events
	 */
	socket.on("typing", ({ caseId, user }) => {
		io.to(caseId).emit("typing", { caseId, user });
	});

	socket.on("stopTyping", ({ caseId, user }) => {
		io.to(caseId).emit("stopTyping", { caseId, user });
	});

	/**
	 * Send message - broadcast to the specific room
	 */
	socket.on("sendMessage", (messageData) => {
		const { caseId } = messageData;
		console.log(
			"sendMessage received on server -> broadcast to room",
			messageData
		);
		io.to(caseId).emit("receiveMessage", messageData);
	});

	/**
	 * New Chat
	 */
	socket.on("newChat", (data) => {
		console.log("New chat data:", data);
		io.emit("newChat", data);
	});

	/**
	 * Delete message
	 */
	socket.on("deleteMessage", ({ caseId, messageId }) => {
		console.log(`Message deleted in case ${caseId}: ${messageId}`);
		io.to(caseId).emit("messageDeleted", { caseId, messageId });
	});

	/**
	 * Disconnection
	 */
	socket.on("disconnect", (reason) => {
		console.log(`A user disconnected: ${reason}`);
	});

	socket.on("connect_error", (error) => {
		console.error(`Connection error: ${error.message}`);
	});
});
