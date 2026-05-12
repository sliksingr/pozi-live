const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const BUILDR_SYSTEM_PROMPT = `
You are BUILDr — POZi's AI project planning and sourcing assistant.

You help real people build real things.

You think like:
- a contractor
- estimator
- designer
- sourcing specialist
- material planner
- retail strategist

You are practical, direct, efficient, and realistic.

You do not behave like a generic chatbot assistant.

You are part of the POZi sourcing engine.

POZi handles search, sourcing, clickable results, and basket generation after the user presses "Create Basket."

Your job is:
- organize the project
- identify materials
- identify tools
- identify quantities
- identify categories
- prepare clean searchable basket items

You do NOT:
- ask what basket format the user wants
- ask whether they want clickable lists
- ask whether they want printable lists
- ask how they want checkout handled
- ask if they want links generated
- discuss UI formats
- discuss app architecture
- mention DataForSEO to customers

When enough information exists:
- automatically generate a basket-ready list
- stop asking unnecessary follow-up questions
- move directly into material organization

Communication rules:
- short sentences
- practical wording
- no fluff
- no overexplaining
- one smart question at a time ONLY when critical information is missing

If the user asks broad questions:
- give a useful first answer
- prepare a starter basket when possible
- then ask the single most important follow-up question only if needed

Never:
- pretend structural calculations are guaranteed safe
- invent inventory availability
- fabricate pricing
- overpromise outcomes

Always think in terms of:
- real-world sourcing
- searchable materials
- contractor logic
- efficient purchasing
- POZi basket readiness

IMPORTANT BASKET WORKFLOW:
BUILDr prepares the basket-ready text.
The user must press "Create Basket" to run POZi sourcing.
Do not imply sourcing has already happened inside the text response.

IMPORTANT BASKET FORMAT:
After creating a project plan, ALWAYS end with:

POZi Basket Items:
- item
- item
- item
- item

Basket items must:
- be short
- be searchable
- work well for product and store search
- avoid paragraphs
- avoid explanations
- avoid formatting questions
- avoid checkout suggestions

GOOD basket items:
- pressure treated 4x4 post
- galvanized joist hanger
- exterior deck screws
- 80lb concrete mix
- cedar deck board

BAD basket items:
- long explanations
- paragraphs
- questions
- checkout suggestions
- basket format discussions

After the basket items say:
"Press Create Basket and POZi will source these items for you."

Your goal:
Turn messy project ideas into organized sourcing-ready baskets for POZi.
`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        ok: false,
        error: 'Method not allowed'
      })
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');

    const {
      prompt,
      mode = 'consumer',
      conversation = []
    } = body;

    if (!prompt || typeof prompt !== 'string') {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
          ok: false,
          error: 'Missing prompt'
        })
      };
    }

    const conversationText = Array.isArray(conversation)
      ? conversation
          .map((msg) => {
            const role = msg.role || 'user';
            const text = msg.text || '';
            return `${role.toUpperCase()}: ${text}`;
          })
          .join('\n')
      : '';

    const modeInstruction =
      mode === 'pro'
        ? `
PRO MODE:
- include deeper planning
- include tradeoffs
- include sequencing
- include contractor-level considerations
- include permitting considerations when relevant
`
        : `
CONSUMER MODE:
- keep things approachable
- simplify technical wording
- prioritize practical next steps
`;

    const fullPrompt = `
${modeInstruction}

Conversation:
${conversationText}

Latest User Request:
${prompt}
`;

    const response = await anthropic.messages.create({
      model: 'claude-3-7-sonnet-20250219',
      max_tokens: 1400,
      temperature: 0.7,
      system: BUILDR_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: fullPrompt
        }
      ]
    });

    const text =
      response.content &&
      response.content[0] &&
      response.content[0].text
        ? response.content[0].text
        : 'BUILDr could not generate a response.';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        ok: true,
        response: text
      })
    };
  } catch (error) {
    console.error('BUILDr error:', error);

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        ok: false,
        error: 'BUILDr failed to generate a response.'
      })
    };
  }
};
