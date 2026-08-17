import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initStore } from "./store";
import "./cassie.css";

initStore();
createRoot(document.getElementById("root")!).render(<App />);
