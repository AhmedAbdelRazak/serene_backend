const express = require("express");
const mongoose = require("mongoose");
const morgan = require("morgan");
const cors = require("cors");
const { readdirSync } = require("fs");
require("dotenv").config();

const http = require("http");
const socketIo = require("socket.io");
const cron = require("node-cron");
const axios = require("axios");

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

// routes middlewares
readdirSync("./routes").map((r) => app.use("/api", require(`./routes/${r}`)));

// Schedule task to run every 90 minutes
cron.schedule("*/59 * * * *", async () => {
	try {
		console.log("Running scheduled task to fetch Printify orders");
		const response = await axios.get(
			"http://localhost:8101/api/get-printify-orders"
		);
		console.log("Orders Updated From Printify");
	} catch (error) {
		console.error("Error during scheduled task:");
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
		// Include caseId in the payload so that only the correct chat updates
		io.to(caseId).emit("typing", { caseId, user });
	});

	socket.on("stopTyping", ({ caseId, user }) => {
		io.to(caseId).emit("stopTyping", { caseId, user });
	});

	/**
	 * Send message - broadcast to the specific room
	 *
	 * NOTE: In your controllers, once the DB is updated, you do:
	 *   req.io.emit("receiveMessage", updatedCase);
	 * or
	 *   req.io.to(caseId).emit("receiveMessage", updatedCase);
	 *
	 * That’s fine, as long as the client code expects an entire updatedCase object.
	 */
	socket.on("sendMessage", (messageData) => {
		// Typically you do NOT update the DB here if you're using your REST endpoint to do it.
		// But if you prefer a pure-socket approach, you’d do it here.
		// For now, just re-broadcast so others see it in real-time:
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
		// If you want to broadcast to all connected admin/agents:
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
