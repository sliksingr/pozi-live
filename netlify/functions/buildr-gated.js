exports.handler = async (event) => {
  const fetch = (...args) =>
    import('node-fetch').then(({ default: fetch }) => fetch(...args));

  try {
    const body = JSON.parse(event.body || '{}');

    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    if (!anthropicKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Missing ANTHROPIC_API_KEY'
        })
      };
    }

    const userPrompt = body.message || '';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1200,
        messages: [
          {
            role: 'user',
            content: userPrompt
          }
        ]
      })
    });

    const data = await response.json();

    return {
      statusCode: 200,
      body: JSON.stringify(data)
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err.message
      })
    };
  }
};
