import { context, requestExpandedMode } from '@devvit/web/client';

const startButton = document.getElementById('start-button') as HTMLButtonElement;
const greeting = document.getElementById('greeting') as HTMLParagraphElement;

startButton.addEventListener('click', (e) => {
  requestExpandedMode(e, 'game');
});

// Personalize for logged-in Redditors; the default line already works cold.
if (context.username) {
  greeting.textContent = `u/${context.username} — three stones a day. One shared board. Knock, bank, avenge.`;
}
