Online shop: customers, products, orders and order lines. Use for sales, revenue and customer questions; not for stock levels (use inventory).

## How to query
- Revenue = SUM(OrderItems.Quantity * OrderItems.UnitPrice). Exclude orders with Status = 'Cancelled'.
- Orders (50k rows) and OrderItems (150k rows) are large. Use TOP while exploring and always filter or aggregate.
- For per-customer totals use the view dbo.vCustomerSpend instead of joining the three tables yourself.
- Dates are UTC (DATETIME2). Convert to local time only when the user asks for it.

## Tables
- dbo.Customers: one row per customer. Country is an ISO-2 code (SG, US, UK, JP, AU).
- dbo.Products: catalogue. Category is one of Books, Electronics, Toys, Garden. Price is the current list price.
- dbo.Orders: one row per order. Status is Pending, Shipped, Delivered or Cancelled.
- dbo.OrderItems: one row per product in an order. UnitPrice is the price paid, which can differ from Products.Price.

## Common joins
- Orders.CustomerId -> Customers.CustomerId
- OrderItems.OrderId -> Orders.OrderId
- OrderItems.ProductId -> Products.ProductId

## Gotchas
- Orders.CustomerId has no index, so filtering on it scans the whole table. Use analyze_query if a query is slow.
- Customer names are placeholders ("Customer 42"); don't treat them as real people.
