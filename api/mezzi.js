/*
ER-TPL High Availability API
Copyright (C) 2025-26 Vichingo455

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// Roba da non modificare assolutamente
export const config = {
  runtime: "edge"
};

const corsHeaders = {
  //"Access-Control-Allow-Origin": "https://ertpl.pages.dev",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

// Lista dei server modificabile
const servers = [
    {
      name: "Serverissimo",
      url: "https://mezziapi.serverissimo.com/health",
      apiEndpoint: "/api"
    },
    {
      name: "DaniLab",
      url: "https://ertpl-db.daninet.freeddns.org/health",
      apiEndpoint: "/api"
    },
    {
      name: "Vichingo455",
      url: "https://api.vichingo455.com/ertpl/health",
      apiEndpoint: ""
    }
  ];

// Altra roba da modificare solamente in caso di bisogno
async function checkServer(server, timeoutMs = 1500) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(server.url, {
      headers: {
        Range: "bytes=0-0"
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) return false;
    const data = await response.json();
    return data.status == "ok";
  } catch {
    return false;
  }
}

export default async function handler() {
  for (const server of servers) {
    if (await checkServer(server)) {
      return new Response(
        JSON.stringify({
          status: "ok",
          server: server.name,
          url: server.url.replace("/health",server.apiEndpoint)
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Cache-Control": "public, s-maxage=30"
          }
        }
      );
    }
  }

  return new Response(
    JSON.stringify({ status: "offline" }),
    {
      status: 503,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
}