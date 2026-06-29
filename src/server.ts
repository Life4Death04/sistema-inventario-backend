// HTTP listener — imports the Express app and starts listening.
// Extended in Slice 3 with env validation and structured logging.
import { app } from './app.js';

const PORT = process.env['PORT'] ?? '3000';

app.listen(Number(PORT), () => {
  console.info(`Server listening on port ${PORT}`);
});
