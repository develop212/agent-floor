// Local dry-run /actions handler. The Request is a real POST-shaped request,
// but it is resolved here and never passed to the network or the Agent Floor server.
export type StudioActionPayload = {
  action: 'claim_request' | 'review';
  agent?: string;
  task_id?: string;
  result?: string;
  note?: string;
  ts: number;
};

export const dryRunActionRequests: StudioActionPayload[] = [];

export async function postStudioAction(payload: StudioActionPayload): Promise<Response> {
  const request = new Request('/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return localActionHandler(request);
}

async function localActionHandler(request: Request): Promise<Response> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/actions') {
    return Response.json({ error: '模拟｜未知动作入口' }, { status: 404 });
  }
  const body = await request.json() as StudioActionPayload;
  dryRunActionRequests.push(body);
  return Response.json({ accepted: true, mode: '模拟模式', pending: true }, { status: 202 });
}
