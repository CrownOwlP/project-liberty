export async function GET() {
  return Response.json({
    status: "ok",
    service: "project-liberty-web",
    timestamp: new Date().toISOString()
  });
}
