/** @format */

const ContactUs = require("../models/contactusForm");
const sgMail = require("@sendgrid/mail");
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const ahmed = "ahmedabdelrazzak1001010@gmail.com";

exports.contactForm = (req, res) => {
	const Form = new ContactUs(req.body);
	console.log(req.body);
	Form.save((err, form) => {
		if (err) {
			return res.status(400).json({
				// error: errorHandler(err)
				error: "Not Complete Form, Please fill in empty fields",
			});
		}
		res.json({
			form,
		});

		const FormSubmittionEmail = {
			to: form.email,
			from: "noreply@onlineStore.com",
			subject: `Online Store - Confirmation`,
			html: `
          Hi ${form.name},
          <br />
          <br />
            <div>Thank you for contacting <a href="www.onlineStore.com/all-products"> Online Store</a>.</div>
            <h4> Our support team will respond within the next 1 to 24 hours.
            </h4>
             For urgent issues please check our <a href="www.onlineStore.com/contact"> Contacting Details Here</a>.
             <br />
             <br />
             Kind and Best Regards,  <br />
             Online Store support team <br />
             Contact Email: info@onlineStore.com <br />
             Phone#: (951) 503-6818 <br />
             Landline#: (951) 497-3555 <br />
             Address:  17798 Camino San Simeon, Moreno Valley, CA, 92551.  <br />
             &nbsp;<img src="https://onlineStore.com/api/product/photo5/5efff6005275b89938abe066" alt="onlineStore" style=width:50px; height:50px />
             <p>
             <strong>Online Store LLC.</strong>  
              </p>

        `,
		};
		sgMail.send(FormSubmittionEmail);

		const InquiryFromCustomer = {
			to: ahmed,
			from: "noreply@onlinestore.com",
			subject: `Online Store - Inquiry From a customer - (Name: ${form.name})`,
			html: `
          Hi Team,
          <br />
          <br />
            <div>You have just received an inquiry from a customer who used  <a href="www.onlinestore.com/contact"> this link</a>, please make sure that you respond ASAP! </div>
            <p>
                <h3>Here is the inquiry details: </h3>
                &nbsp;&nbsp; <strong>Name </strong>:${form.name}<br />
                &nbsp;&nbsp; <strong>Email </strong>:${form.email}<br />
                &nbsp;&nbsp; <strong>Subject </strong>:${form.subject}<br />
                &nbsp;&nbsp; <strong>Inquiry/Message </strong>:${form.text}<br />
            </p>
             <br />
             Kind and Best Regards,  <br />
             Online Store support team <br />
             Contact Email: info@onlinestore.com <br />
             Phone#: (951) 503-6818 <br />
             Landline#: (951) 497-3555 <br />
             Address:  17798 Camino San Simeon, Moreno Valley, CA, 92551.  <br />
             &nbsp;<img src="https://onlinestore.com/api/product/photo5/5efff6005275b89938abe066" alt="PuristicLyf" style=width:50px; height:50px />
             <p>
             <strong>Online Store LLC.</strong>  
              </p>

        `,
		};
		sgMail.send(InquiryFromCustomer);
	});
};
