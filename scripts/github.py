"""Shared GitHub API helpers used by poll_projects.py and worker.py."""
import os
import subprocess

import requests

GH_TOKEN    = os.environ.get('GITHUB_TOKEN', '')
GH_ENV      = {**os.environ, 'GH_TOKEN': GH_TOKEN}
GRAPHQL_URL = 'https://api.github.com/graphql'
GQL_HEADERS = {'Authorization': f'Bearer {GH_TOKEN}', 'Content-Type': 'application/json'}


def gql(query: str, variables: dict | None = None) -> dict:
    resp = requests.post(
        GRAPHQL_URL, headers=GQL_HEADERS,
        json={'query': query, 'variables': variables or {}}, timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    if 'errors' in data:
        raise RuntimeError(f'GraphQL errors: {data["errors"]}')
    return data['data']


def gh(*args: str) -> str:
    result = subprocess.run(['gh', *args], capture_output=True, text=True, env=GH_ENV)
    return result.stdout.strip()
