"""Client for the Open Air Home Assistant API."""

from dataclasses import dataclass
import math
from typing import Any

from aiohttp import BasicAuth, ClientError, ClientSession, ClientTimeout


class OpenAirError(Exception):
    """The Open Air request failed."""


class OpenAirAuthError(OpenAirError):
    """Open Air or the reverse proxy rejected the credentials."""


class OpenAirProtocolError(OpenAirError):
    """The server did not respond with the supported Open Air API."""


def numeric(value: Any) -> int | float | None:
    """Read a finite number from a JSON response."""
    if type(value) in (int, float) and math.isfinite(value):
        return value
    return None


@dataclass(frozen=True)
class Source:
    """A named preset on the Open Air server."""

    id: str
    name: str
    frequency: int


@dataclass(frozen=True)
class Catalog:
    """The server's available presets and receive modes."""

    sources: tuple[Source, ...]
    modes: dict[str, str]


class OpenAirClient:
    """Read and control one Open Air server."""

    def __init__(
        self,
        session: ClientSession,
        origin: str,
        token: str,
        proxy_username: str = "",
        proxy_password: str = "",
    ) -> None:
        self.origin = origin
        self._session = session
        self._headers = {"Accept": "application/json", "X-Open-Air-Token": token}
        self._proxy_auth = (
            BasicAuth(proxy_username, proxy_password, encoding="utf-8")
            if proxy_username
            else None
        )

    async def _request(
        self, endpoint: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        method = "GET" if payload is None else "POST"
        timeout = ClientTimeout(total=10 if payload is None else 30)
        try:
            async with self._session.request(
                method,
                f"{self.origin}/api/ha/{endpoint}",
                headers=self._headers,
                auth=self._proxy_auth,
                json=payload,
                timeout=timeout,
                allow_redirects=False,
            ) as response:
                if response.status in (401, 403):
                    raise OpenAirAuthError("Check the Open Air token and proxy credentials.")
                if response.status == 404 or 300 <= response.status < 400:
                    raise OpenAirProtocolError("The URL did not return the Open Air API.")
                if response.status in (400, 409, 422):
                    try:
                        error_body = await response.json()
                    except (ValueError, ClientError):
                        error_body = None
                    if isinstance(error_body, dict) and isinstance(error_body.get("error"), str):
                        raise OpenAirError(error_body["error"])
                if response.status >= 400:
                    raise OpenAirError(f"Open Air returned HTTP {response.status}.")
                try:
                    body = await response.json()
                except (ValueError, ClientError) as err:
                    raise OpenAirProtocolError("Open Air did not return JSON.") from err
        except (ClientError, TimeoutError) as err:
            raise OpenAirError("Could not reach the Open Air server.") from err
        if not isinstance(body, dict):
            raise OpenAirProtocolError("Open Air returned an invalid response.")
        return body

    async def get_state(self) -> dict[str, Any]:
        """Read the current radio and scanner state."""
        body = await self._request("state")
        if (
            type(body.get("apiVersion")) is not int
            or body["apiVersion"] != 1
            or type(body.get("connected")) is not bool
            or type(body.get("running")) is not bool
        ):
            raise OpenAirProtocolError("Open Air API version 1 is required.")
        return body

    async def get_catalog(self) -> Catalog:
        """Read the radio presets and receive modes."""
        body = await self._request("sources")
        sources = body.get("sources")
        modes = body.get("modes")
        if not isinstance(sources, list) or not isinstance(modes, list):
            raise OpenAirProtocolError("Open Air did not return its presets and receive modes.")
        return Catalog(
            tuple(
                Source(source["id"], source["name"], source["frequency"])
                for source in sources
                if isinstance(source, dict)
                and isinstance(source.get("id"), str)
                and isinstance(source.get("name"), str)
                and type(source.get("frequency")) is int
                and source["frequency"] > 0
            ),
            {
                mode["id"]: mode["label"]
                for mode in modes
                if isinstance(mode, dict)
                and isinstance(mode.get("id"), str)
                and isinstance(mode.get("label"), str)
            },
        )

    async def run_command(self, endpoint: str, payload: dict[str, Any]) -> None:
        """Send a receiver command."""
        await self._request(endpoint, payload)
