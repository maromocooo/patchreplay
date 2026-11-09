const form = document.querySelector("#add");
const input = document.querySelector("#item");
const list = document.querySelector("#list");
const empty = document.querySelector("#empty");
const count = document.querySelector("#count");
const items = [];

function render() {
  list.innerHTML = items.map((t) => `<li>${t}</li>`).join("");
  count.textContent = `${items.length} item(s)`;
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  items.push(text);
  input.value = "";
  render();
});

render();
