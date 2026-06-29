// Express application factory — builds the app without starting the listener.
// Import this in tests (Supertest) without opening any port.
// Full middleware wiring is added in Slice 3 (express-base).
import express from 'express';

const app = express();

export { app };
