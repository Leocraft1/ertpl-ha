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
		url: "https://startapi.serverissimo.com/health"
	},
	{
		name: "DaniLab",
		url: "https://startapi.daninet.freeddns.org/health"
	},
	{
		name: "Vichingo455",
		url: "https://api.vichingo455.com/start/health"
	}
];

// Altra roba da modificare solamente in caso di bisogno
async function checkServer(server, timeoutMs = 1500) {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		const response = await fetch(server.url, {
			signal: controller.signal
		});
		clearTimeout(timeout);
		return response.ok;
	} catch {
		return false;
	}
}

export default async function handler() {
	const state = await kvGet("arbiter:state");
	if (!state || !state.currentMaster) {
		return new Response(JSON.stringify({ status: "offline" }), {
			status: 503,
			headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" }
		});
	}
	return new Response(JSON.stringify({ status: "ok", server: state.currentMaster }), {
		headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" }
	});
}