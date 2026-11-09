// The tests read JSON answers loosely.
interface Response {
  json(): Promise<any>;
}
