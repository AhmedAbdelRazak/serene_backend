/** @format */

const express = require("express");
const router = express.Router();

const { contactForm } = require("../controllers/contactusForm");

router.post("/submitform", contactForm);

module.exports = router;
