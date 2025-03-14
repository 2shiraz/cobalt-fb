import { Agent, ProxyAgent, fetch } from 'undici';

// Function to fetch a proxy from a rotating proxy service with retries
export async function fetchToken(retries = 6, delay = 500) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetch('http://88.99.226.59:5555/');

            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }

            const data = await response.json();
            const { visitorData, poToken } = data;

            if (!visitorData || !poToken) {
                throw new Error('invalid response');
            }

            return data;
        } catch (err) {
            console.warn(`Attempt ${attempt} failed: ${err.message}`);

            if (attempt < retries) {
                await new Promise((resolve) => setTimeout(resolve, delay)); // Wait before retrying
            } else {
                throw new Error(`Failed to fetch proxy after ${retries} attempts: ${err.message}`);
            }
        }
    }
}
