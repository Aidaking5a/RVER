import Groq from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

const models = await groq.models.list();

for (const model of models.data) {
    console.log(model.id);
}