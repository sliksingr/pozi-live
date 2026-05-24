const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {

  try {

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const body = JSON.parse(event.body || '{}');

    const sessionId = body.sessionId || 'guest';

    const today = new Date().toISOString().split('T')[0];

    let { data: existing } = await supabase
      .from('usage_tracking')
      .select('*')
      .eq('session_id', sessionId)
      .eq('usage_date', today)
      .single();

    if (!existing) {

      const { data: inserted } = await supabase
        .from('usage_tracking')
        .insert({
          session_id: sessionId,
          usage_date: today,
          builder_sessions: 0,
          photo_uploads: 0,
          account_type: 'guest'
        })
        .select()
        .single();

      existing = inserted;
    }

    return {
      statusCode: 200,
      body: JSON.stringify(existing)
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
