# Database graph (owner's idea, captured 2026-11-11)

A separate future feature. Build 7 borrows its derived-field ideas for generated table fns (see
`docs/plans/build-7.md`, section 4). The rest is not scheduled yet.

## The owner's notes, verbatim

> Database Graph
> Goal: take any DB schema and through FKs and column types come up with a way to build a visual graph of nodes and edges where the nodes and edges chosen and visualized based on measurements. A starting set of rows is decided then the graph is iteratively traversed to pull in all related up to N times. The size and color of the nodes and edges are calculated by normalized values that communicate whatever the user wants. A given visual (ex: line width) could have its normalized weight be a min/max/avg/product of several normalized values. The graph has a global set of conditions applied to each table (ex: only activity in the past 30d), plus the starting set, and then each one to many relation can have a set of conditions. Because a database can be massive and there's only so much space for nodes and edges to make them nice - a sortable value is also chosen for the initial set and edges to only display X nodes & Y edges at time, but a +more node exists to load in more. Numeric & date values drive weighting calculations.
>
> An LLM will be fed the schema, explained the available equations, and available expressions and it's job is to convert the user request into a traversable graph. It defines the global filters, start set, which relations should be traversed, how edge/node visuals should be calculated, etc. That's one JSON structured output to describe it. The front and backend then takes that to provide the visual graph experience.
>
> Simple Example DB:
> Project { name, status, amount, owner }
> Owner { name, projects }
>
> | = Or
>
> Normalization equations (num / denom):
> - count|order / count
> - value|avg|median / sum
> - (value|avg|median - min) / (max - min)
> - value|avg|median / max
>
> normalized value always represents progress, portion, relative
>
> Expression syntax:
> rows(condition)?
> - .count
> - .field.sum|avg|min|max|median
> - .field.order.asc|desc.nullsFirst|Last
> Ie: rows are table or relation from a row
>
> row
> - .numericField
> - .dateField
> - .booleanField (converted to 0 or 1)
> - .textField.length
> - .related: row
> - .related: rows
> Ie: a node
>
> Syntax Ex:
> - projects.count (how many total projects)
> - projects.amount.sum (sum of amount on all projects)
> - project.amount.order.desc.nullsLast (0-N where the highest amount project is 0)
> - project.amount (node value)
> - project.owner.projects.amount.avg
> - owner.projects.count
> - owner.projects.amount.sum
> - owner.projects(status=Active).amount.sum
> - project.name.length
>
> Next up, how to do edges and deep relationships?
>
> 1. Add hasMany computed fields
> [hasManyRelation]
> - Count
> - Sum[numericField]
> - [Avg|Min|Max|Median][numericField|dateField]
> - for each sortable column on relation:
>   - Order[Asc|Desc][column]
> - for each enum on relation:
>   - [column][value]* all computed above*
>
> Ex:
> - projectAvgAmount
> - projectStatusDoneAvgAmount
> - projectOrderAscAmount
>
> 2. Add belongsTo computed fields
> - for each field on [relation]:
>   - [relation][relationFields]
>
> Ex:
> - ownerProjectAvgAmount
>
> 3. Apply same hasMany aggregation logic to produce table wide values:
> Ex:
> - avgAmount
>
> Every field comes from a table & column - and that determines numerator/denominator compatibility.
>
> Repeat N times
