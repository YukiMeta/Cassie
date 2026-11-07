import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initStore } from "./store";
import "./cassie.css";
import "./viewer.css";

initStore();
createRoot(document.getElementById("root")!).render(<App />);
