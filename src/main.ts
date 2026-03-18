import { createApp } from "vue";
import Tres from "@tresjs/core";
import App from "./App.vue";
import "./style.css";

const app = createApp(App);
app.use(Tres);
app.mount("#app");
