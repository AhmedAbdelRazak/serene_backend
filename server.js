// const express = require("express");
// const mongoose = require("mongoose");
// const morgan = require("morgan");
// const cors = require("cors");
// const { readdirSync } = require("fs");
// require("dotenv").config();
// const http = require("http");
// const socketIo = require("socket.io");
// const cron = require("node-cron");
// const axios = require("axios");

// // app
// const app = express();
// const server = http.createServer(app);

// // db
// mongoose
// 	.connect(process.env.DATABASE)
// 	.then(() => console.log("MongoDB Atlas is connected"))
// 	.catch((err) => console.log("DB Connection Error: ", err));

// // middlewares
// app.use(morgan("dev"));
// app.use(cors());
// app.use(express.json({ limit: "50mb" }));

// app.get("/", (req, res) => {
// 	res.send("Hello From ecommerce API");
// });

// // Create the io instance
// const io = socketIo(server, {
// 	cors: {
// 		origin: "*",
// 		methods: ["GET", "POST"],
// 		allowedHeaders: ["Authorization"],
// 		credentials: true,
// 	},
// });

// // Pass the io instance to the app
// app.set("io", io);

// // routes middlewares
// readdirSync("./routes").map((r) => app.use("/api", require(`./routes/${r}`)));

// // Schedule task to run every 15 minutes
// cron.schedule("*/90 * * * *", async () => {
// 	try {
// 		console.log("Running scheduled task to fetch Printify orders");
// 		const response = await axios.get(
// 			"http://localhost:8101/api/get-printify-orders"
// 		);
// 		console.log("Orders Updated From Printify");
// 	} catch (error) {
// 		console.error("Error during scheduled task:");
// 	}
// });

// const port = process.env.PORT || 8101;

// server.listen(port, () => {
// 	console.log(`Server is running on port ${port}`);
// });

// io.on("connection", (socket) => {
// 	console.log("A user connected");

// 	socket.on("sendMessage", (message) => {
// 		console.log("Message received: ", message);
// 		io.emit("receiveMessage", message);
// 	});

// 	socket.on("typing", (data) => {
// 		io.emit("typing", data);
// 	});

// 	socket.on("stopTyping", (data) => {
// 		io.emit("stopTyping", data);
// 	});

// 	socket.on("disconnect", (reason) => {
// 		console.log(`A user disconnected: ${reason}`);
// 	});

// 	socket.on("connect_error", (error) => {
// 		console.error(`Connection error: ${error.message}`);
// 	});
// });

/////////////////////////////////////////////////////
const express = require("express");
const mongoose = require("mongoose");
const morgan = require("morgan");
const cors = require("cors");
const { readdirSync } = require("fs");
require("dotenv").config();
const cron = require("node-cron");
const axios = require("axios");

// app
const app = express();

// db
mongoose
	.connect(process.env.DATABASE)
	.then(() => console.log("MongoDB Atlas is connected"))
	.catch((err) => console.log("DB Connection Error: ", err));

// middlewares
app.use(morgan("dev"));
app.use(cors({ origin: "https://serenejannat.com" }));
app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => {
	res.send("Hello From ecommerce API");
});

// routes middlewares
readdirSync("./routes").map((r) => app.use("/api", require(`./routes/${r}`)));

// Schedule task to run every 15 minutes
cron.schedule("*/10 * * * *", async () => {
	try {
		console.log("Running scheduled task to fetch Printify orders");
		const response = await axios.get(
			"https://serenejannat.com:8101/api/get-printify-orders"
		);
		console.log("Scheduled Task for Printify");
	} catch (error) {
		console.error("Error during scheduled task:");
	}
});

const port = process.env.PORT || 8101;

app.listen(port, () => {
	console.log(`Server is running on port ${port}`);
});
