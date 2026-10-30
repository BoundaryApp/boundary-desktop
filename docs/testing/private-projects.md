# Private projects check

Needs a local model, OpenRouter and, for the last two steps, a second Mac sharing a model.

1. Open a project pinned to Local. Turn on **Private** in its Inference block. OpenRouter shows "not private" and can't be picked.
2. Pin Local with OpenRouter as a fallback. The fallback reads "Not used: this project is private."
3. Stop the local server and send. The prompt offers Retry local and no OpenRouter button.
4. Turn **Private** off, pin OpenRouter, turn **Private** on. The block warns that chats can't send. A chat there shows the prompt, the chip reads "not private, can't send", and no reply starts.
5. Click **Send with Local**. The reply comes from Local and the chip reads "overridden for this chat".
6. Set the app default to OpenRouter and let a Private project inherit it. Chats are refused the same way.
7. Move a chat pinned to OpenRouter into a Private project. Its send is refused. Turn **Private** off and it sends through OpenRouter again.
8. In a Private project with a channel, @-mention a member. It obeys the same refusal.
9. With a provider's **Private** off in Circles, a chain of Local then their model never reaches them. Stop the local server and confirm the send stops.
10. Turn that provider's **Private** on, keep **Trusted** on, stop the local server and send. Their model answers and the transcript names them.
